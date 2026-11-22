import { describe, expect, it } from "vitest";
import { ProgressChannel } from "./progress.js";

const event = (jobId: string | undefined, done: number) => ({ jobId, stage: "apply", done, total: 3 });

async function collect(events: AsyncIterable<{ done: number }>): Promise<number[]> {
  const seen: number[] = [];
  for await (const e of events) seen.push(e.done);
  return seen;
}

describe("ProgressChannel", () => {
  it("gives each subscriber the events for its job, in order, and ends when closed", async () => {
    const channel = new ProgressChannel();
    const mine = collect(channel.subscribe("j1"));
    const everything = collect(channel.subscribe());

    channel.emit(event("j1", 1));
    channel.emit(event("j2", 2));
    channel.emit(event(undefined, 3));
    channel.close();

    expect(await mine).toEqual([1, 3]);
    expect(await everything).toEqual([1, 2, 3]);
  });

  it("keeps events emitted before the consumer starts reading, and does not see earlier ones", async () => {
    const channel = new ProgressChannel();
    channel.emit(event("j", 0));
    const late = channel.subscribe("j");
    channel.emit(event("j", 1));
    channel.close();

    expect(await collect(late)).toEqual([1]);
  });

  it("stops delivering to a consumer that stops reading, without disturbing the others", async () => {
    const channel = new ProgressChannel();
    const quitter = channel.subscribe()[Symbol.asyncIterator]();
    const other = collect(channel.subscribe());

    channel.emit(event("j", 1));
    expect((await quitter.next()).value).toMatchObject({ done: 1 });
    await quitter.return!();
    channel.emit(event("j", 2));
    channel.close();

    expect(await other).toEqual([1, 2]);
    expect((await quitter.next()).done).toBe(true);
  });
});
