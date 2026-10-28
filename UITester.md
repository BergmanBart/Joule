# UI tester
Ultimate goal is to build a application which making, mainting and running UI tests really easy. A project should be able to have 1 or more test, and for each test it should be easy to define how to run the test. When you open the application on the left you have an overview on the tests, If you select a test on the left, you get on the right of that an overview of all the steps of the specific test. To the right of that is a browser view of the defined URL (See parameter tab). All the way on the right of the screen you see the details of each action or assertion that is defined. 

## Parameters
For each project a set of parameters can be defined. Every project has a URL parameter, this one is mandatory. Other parameters are optional. You should be able to give a name and a value. Later when building you should be able to use ${parameter_name}. For example, when we have to fill in a text field, we can use a parameter to always fill in the same for each test in the project.

### Test Specific parameters
Each test can also have test specific parameters. If variable is the same as in the project parameter, the test parameter overwrites the project parameter, but a subtle warning should be shown that you are overwriting a parameter. 

## The browser view
When you start a new project you always have to define a URL. When the project is opened initially, there is only 1 test which is called "Test1". It will show that there are no events  defined, and the URL is instantly loaded in.  If you click on something in the browser view, a red outline around that object is added. It directly adds a event to the list (so the second column counting from the left). All the way on the right it opens the details of that event. We will define those details later, but that field needs a cross so that I can easily deselect that specific event. Events that are created after the first one also need to be outlined. When you select 1 event, the box of all other events will get a decrease in opacity so that it becomes easier to view the selected event. All events have a little number on the top left added to them, this way we can see the order of the events  in the screen. 

## The Test overview
Each tests in essence is just a list of events ofcourse. In order to increase the readability of this tab, we should be able to group events, and make them collapsible. The group should be able to have a name that can be defined by the user. For example: Login[Enter username, Enter Password, Click submit]. It would also be nice to have the possibility to copy and paste the such a group to other tests.  If it is easier than I think it is, a nice to have would be to even have the possibility to reuse groups. This allows us to have easier to maintain code. 

It should also be possible to select multiple events or multiple groups. If a group is selected it should behave the same as when you select all events below that. When you make a selection, it should be possible to run only those events. This allows you to test specific functions in the browser view. 

Each event type should have a different colour. And a different icon. This makes it easier to see what is happening in 1 view. 

## Events details view
When an event  is selected. On the right of the screen the detail tab should be shown. Here you can do multiple stuff
### Action or Assert
You should be able to select wether the action is actually an action or an assertion. Both should be possible on each type of HTML element. 
### Search details
It should be quite easy to determine how the code "finds" the element to put the event on. For example, the type of HTML element, the value of the element, or the class. Basically every possible variable that an HTML element can have. If the user changes the search properties, the application should show wether it still finds only 1 HTML element, or multiple or zero. Show this as a warning, but dont block the user from saving like that. Also visualize the other elements that are found when multiple elements have been found.
### If Assert
If the event is an assertion, the user should be able to assert that any HTML element is something. For example, the title of a button is a value. This assertion should also be possible to compare to a project parameter.
### If Action
Now it depends on what kind of HTML element we get. If it is a button, allow the basic actions like click, double click and right click. If it is a text field allow to enter text. If it is any other type, add a the same possibilities as button. 

## Other events
Some other events, that are not dependend on the HTML page should also be possible to be added. This can be done in the second column from the left. 
### Wait event
You should be able to add a wait event. This can be based on an element, on time or on the page being loaded.
###  Pause
A pause should just wait until the user inputs does something in the terminal it is running (like hitting any key). When this is used inside the application a clear button to start the run again should appear. This is ofcourse also nice to use when building the entire test
### If statement
We should be able to add an if statement based on an assertion. If the if statement is true, then we should do an following event. This should be illustrated in the second column (the event overview). Nested If statements should be allowed, there is no limit to the amount of nested, but if there is more than 5 or something it will be ugly of course. 
### Screenshots
There should be an event which adds a screenshot. As a standard, use a /screenshots folder in the project folder. Allow the user to change this in the project settings. (Note: In order for the software to load in settings they need to be saved somewhere in the project folder. 

## Saving
A project should be really quite easy to save. It should save it as a robot framework file, which can be ran independtly of this software (assuming you have the right packages to run robotframework software).  Please note that the software should also be able to open a project again, so maybe add a JSON file in the same folder with all the configurations. When I select open project and it contains files always try to open them like they have been created with this software.

## Settings
Like mentioned before, configurations should be saved. Also the settings. The following settings should be there:
Browser (Chrome, Edge, Firefox)
Headless / headed
Screen resolution
Timeout settings
Retry settings
Environment (DEV / TEST / ACC / PROD)

Changing the settings is done in a pop up in order to not clutter the basic UI. This is the same as for the parameter tab. 

## Running tests
We define 1 test as 1 flow through a application. Each test should have a few settings like happy flow / unhappy flow. Smoke test / regression test. Each test should be able to be ran seperately. When you do this, it will run the robot frame work directly. So this will open a new browser tab and fullfill all the actions. So this should be the exact same as it would be when you just run the file normally. There should also be a possibilty to run in inside the app. This makes it easier to use. This should also be the method used when you run only a few seperate events. Make sure that in the project setting (So not test specific settings) you can also run the all the tests without opening a browser, this makes it easier to run in the background. In a project we should also be able to run all tests. The user should be able to make selection on which tests to run in parallel and which tests to run in series. This can be done in the settings. Also make sure this is visualised. 

When a run is finished, always save the logs. 

## General look and feel
The app should look similar to Bruno, with always darkmode. Same like bruno I like the little hamburger icon on the top left which allows you to go to the basic app settings. From here you can open different projects, change the project settings, change the app settings. 

## System
design it as a core library and CLI with a web-based UI. That one codebase can then ship as an npx tool, a VS Code extension, and an Electron app later, so the company’s rules decide the packaging rather than the architecture.