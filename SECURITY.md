# Security policy

## Reporting a vulnerability
Please **don't open a public issue** for a security problem. Report it privately through GitHub:
**Security → Report a vulnerability** on <https://github.com/techkush/spacebench/security> (private vulnerability
reporting). Include what is affected, how to reproduce it and its impact. You'll get a reply as soon as possible;
please give a reasonable time to fix it before disclosing it.

## Supported versions
Space Bench is in early development; fixes go into the latest version on the `main` branch.

## Good to know
- Space Bench runs locally. Circuits, sketches and projects stay on your computer.
- The optional AI assistant sends your request (and the circuit or sketch it is about) to Anthropic only when you
  press **Send**, using your own Claude Code login or API key. An API key is stored in the app's local storage on
  your computer.
- Board emulators, compilers and the Raspberry Pi VM run as separate programs on your machine; Space Bench asks
  before downloading or installing any of them.
