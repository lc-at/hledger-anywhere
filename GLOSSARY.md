# hledger-anywhere

A terminal for hledger that runs entirely in the browser: the hledger CLI in a Web Worker, plugin windows over the journal, no server.

## Language

**Bridge**:
The call path between a plugin window and its plugin, over which the window's requests and the plugin's replies travel.
_Avoid_: connection, link, handler

**Host**:
A plugin's environment as the plugin sees it: its files, the hledger engine, and the settings it may read or write.
_Avoid_: backend, server, context
