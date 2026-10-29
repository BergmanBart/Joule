import {
  Camera,
  CheckSquare,
  Clock,
  Code2,
  Folder,
  GitBranch,
  Keyboard,
  List,
  type LucideIcon,
  MousePointer2,
  MousePointerClick,
  Pause,
  Puzzle,
  ShieldCheck,
  SquareMousePointer,
  TextCursorInput,
  Pointer,
} from 'lucide-react';
import type { Step } from '@joule/core';

export interface StepMeta {
  icon: LucideIcon;
  color: string;
  label: string;
}

const META: Record<string, StepMeta> = {
  click: { icon: MousePointerClick, color: '#60a5fa', label: 'Click' },
  dblclick: { icon: MousePointer2, color: '#60a5fa', label: 'Double click' },
  rightclick: { icon: SquareMousePointer, color: '#818cf8', label: 'Right click' },
  fill: { icon: TextCursorInput, color: '#4ade80', label: 'Enter text' },
  press: { icon: Keyboard, color: '#4ade80', label: 'Press key' },
  hover: { icon: Pointer, color: '#22d3ee', label: 'Hover' },
  select: { icon: List, color: '#2dd4bf', label: 'Select option' },
  check: { icon: CheckSquare, color: '#a3e635', label: 'Check' },
  uncheck: { icon: CheckSquare, color: '#a3e635', label: 'Uncheck' },
  assert: { icon: ShieldCheck, color: '#c084fc', label: 'Assert' },
  wait: { icon: Clock, color: '#fbbf24', label: 'Wait' },
  pause: { icon: Pause, color: '#fb923c', label: 'Pause' },
  screenshot: { icon: Camera, color: '#f472b6', label: 'Screenshot' },
  if: { icon: GitBranch, color: '#facc15', label: 'If' },
  group: { icon: Folder, color: '#a1a1aa', label: 'Group' },
  keywordCall: { icon: Puzzle, color: '#a78bfa', label: 'Keyword' },
  raw: { icon: Code2, color: '#94a3b8', label: 'Robot code' },
};

export function stepMeta(step: Step): StepMeta {
  if (step.type === 'element') return step.mode === 'assert' ? META.assert : META[step.action?.kind ?? 'click'];
  return META[step.type];
}

export function TypeIcon({ step, size = 14 }: { step: Step; size?: number }) {
  const m = stepMeta(step);
  const Icon = m.icon;
  return (
    <span className="type-icon" style={{ background: `${m.color}22`, color: m.color }} title={m.label}>
      <Icon size={size} />
    </span>
  );
}
