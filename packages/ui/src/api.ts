import type { Events, EventType, Requests, RequestType } from '@uitester/core';

type Listener<E extends EventType> = (data: Events[E]) => void;

/** WebSocket client for the UITester server; reconnects automatically. */
class Api {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(d: any) => void>>();
  private queue: string[] = [];
  onConnection?: (connected: boolean) => void;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = (window as any).__UITESTER_WS__ ?? `${proto}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.onConnection?.(true);
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onclose = () => {
      this.onConnection?.(false);
      for (const p of this.pending.values()) p.reject(new Error('Connection lost'));
      this.pending.clear();
      setTimeout(() => this.connect(), 1000);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if ('event' in msg) {
        for (const l of this.listeners.get(msg.event) ?? []) l(msg.data);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
  }

  request<K extends RequestType>(type: K, payload: Requests[K][0] = {} as Requests[K][0]): Promise<Requests[K][1]> {
    const id = this.nextId++;
    const msg = JSON.stringify({ id, type, payload });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg);
      else this.queue.push(msg);
    });
  }

  /** Fire-and-forget for high-frequency input (mouse moves). */
  send<K extends RequestType>(type: K, payload: Requests[K][0]) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ id: 0, type, payload }));
  }

  on<E extends EventType>(event: E, fn: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
}

export const api = new Api();
