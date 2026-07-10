# OpenCode Session Usage

An OpenCode TUI plugin that adds a compact session-usage panel to the sidebar.
It aggregates the root session and all nested subagent sessions.

## Features

- Input, output, reasoning, cache read, and cache write tokens
- Assistant turn count across the root session and all descendants
- Aggregate API cost when OpenCode reports a nonzero cost
- Nested subagent discovery with bounded concurrent requests
- Race-safe refreshes that retain the last complete snapshot on API failure

## Requirements

- OpenCode `>=1.17.9`

## Install

Install globally:

```sh
opencode plugin oc-plugin-session-usage --global
```

Or install locally for the current project:

```sh
opencode plugin oc-plugin-session-usage
```

You can also open the OpenCode plugin manager, select **Install plugin**, and
enter `oc-plugin-session-usage`.

Restart OpenCode after installation if the plugin is not loaded into the
current TUI session.

## Notes

The panel obtains descendant aggregates from OpenCode's session API and fetches
descendant messages to count their assistant turns. Requests are limited to four
concurrent operations. A failed refresh leaves the last complete sidebar values
in place rather than showing partial totals.

Cost is OpenCode's reported estimated API cost. Providers authenticated through
an included subscription, such as ChatGPT Pro/Plus OAuth, can report zero cost;
the cost row is intentionally hidden in that case.

## Development

```sh
npm install
npm run check
npm run pack:check
```

## License

[MIT](LICENSE)
