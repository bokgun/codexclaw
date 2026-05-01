import {
  connectProbe,
  printEventSummary,
  requireObserved,
  startThread,
  startTurn,
  waitForTurnTerminal
} from "./probe-utils.js";

const { client, events } = await connectProbe();

try {
  const threadId = await startThread(client, {});

  const firstStartIndex = events.length;
  await startTurn(client, threadId, "M0 turn streaming probe. Reply with exactly one short sentence.");
  const firstTerminal = requireObserved(
    await waitForTurnTerminal(events, Number(process.env.CODEXCLAW_PROBE_TIMEOUT_MS ?? 120_000), firstStartIndex),
    "first turn terminal event"
  );
  console.error(`[probe] first terminal=${firstTerminal}`);

  const secondStartIndex = events.length;
  await startTurn(client, threadId, "M0 same-thread follow-up probe. Reply with exactly the word ready.");
  const secondTerminal = requireObserved(
    await waitForTurnTerminal(events, Number(process.env.CODEXCLAW_PROBE_TIMEOUT_MS ?? 120_000), secondStartIndex),
    "second turn terminal event"
  );
  console.error(`[probe] second terminal=${secondTerminal}`);

  printEventSummary(events);
} finally {
  client.close();
}
