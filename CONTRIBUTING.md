# Contributing to dotpals

Thanks for helping! The most wanted contributions are **new characters**, **new actions** and **mappings for more agent harnesses**.

## Setup

```bash
git clone <your fork>
cd dotpals
npm run dev   # http://localhost:5173
```

There is no build step and there are no dependencies. Edit the files in `src/` and refresh the page.

## Adding a character

1. Add an entry to `characters` in [src/characters.js](src/characters.js). Draw it in the `200×200` viewBox, sitting on the bottom edge, with the body continuing below `y=200`.
2. Use the `body` gradient for the main shape so it gets fur, shading and color overrides.
3. Mark the eyes with `.dp-blink` and whatever should follow the cursor with `.dp-look`.
4. Set `mouth` and `cheek` so moods draw a mouth and blush in the right place.
5. Add the id to `BuiltInCharacter` in [src/index.d.ts](src/index.d.ts) and to the table in the README.
6. Check every state in the playground. The mouth, the bubble and the blink should all look right.

Characters must be **original artwork**. Please don't copy company logos or brand marks.

## Adding a harness mapping

Add the new event shapes to `toAgentState()` in [src/agent.js](src/agent.js). Return `null` for anything that shouldn't change the state, such as token deltas and pings. In your pull request, include a sample event and the state it should produce.

## Style

- Keep everything dependency-free and framework-agnostic.
- Match the existing code style: ES modules, private `#fields`, and short comments only where the "why" isn't obvious.
