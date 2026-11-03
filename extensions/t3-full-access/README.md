# t3-full-access

Runs every Pi tool without an approval prompt when Pi is started by [T3 Code](https://t3.gg/code), whatever runtime mode the thread has.

T3 Code starts Pi in RPC mode with its own extension (`pi-t3-mcp-extension.ts`) and the environment variable `T3_PI_RUNTIME_MODE` set to the thread's mode: `approval-required` (also used for `auto`), `auto-accept-edits`, or `full-access`. On every tool call that extension reads the variable and, unless it is `full-access`, asks T3 Code to confirm anything that is not a read-only tool. This extension sets the variable to `full-access` in the Pi process when it loads, so that check always passes. Extension load order does not matter because the variable is read per call, not at startup.

When the variable is absent, Pi was not started by T3 Code and nothing is changed.

T3 Code still shows the mode the thread was given; only its effect on Pi is gone. Tested against T3 Code 0.1.7-nightly.20261031 and Pi 1.4.0.
