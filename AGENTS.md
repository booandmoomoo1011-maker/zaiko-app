# Zaikon repository instructions

## Mandatory handoff loading

Before inspecting, editing, testing, publishing, or answering any repository-specific question:

1. Fetch the latest `main` branch.
2. Read `ZAIKON-HANDOFF.md` completely from beginning to end.
3. Treat that file and the latest GitHub `main` as the authoritative project state.
4. Apply this automatically even when the user does not explicitly say “mainのZAIKON-HANDOFF.mdを全文読んでください”.
5. Do not ask the user to repeat the handoff instruction.

If the handoff file cannot be fetched or fully read, stop repository work and clearly report the blocker.

## Safety

Follow every prohibition and release rule in `ZAIKON-HANDOFF.md`. In particular, do not change Firebase settings, existing data, dedicated URLs, GAS settings, Vercel domains, or unrelated app functions unless the user explicitly requests it.
