import { describe, expect, it } from "vitest";
import { InFlightJobs } from "./inFlight.js";

describe("InFlightJobs", () => {
  it("cancels the work a job has entered and nothing of another job", () => {
    const jobs = new InFlightJobs();
    const first = jobs.enter({ jobId: "a" });
    const second = jobs.enter({ jobId: "a" });
    const other = jobs.enter({ jobId: "b" });
    jobs.cancel("a");
    expect([first.signal.aborted, second.signal.aborted, other.signal.aborted]).toEqual([true, true, false]);
    jobs.cancel("never-entered");
  });

  it("follows the job's own signal, including one that has already aborted", () => {
    const jobs = new InFlightJobs();
    const live = new AbortController();
    const followed = jobs.enter({ signal: live.signal });
    expect(followed.signal.aborted).toBe(false);
    live.abort();
    expect(followed.signal.aborted).toBe(true);

    const spent = new AbortController();
    spent.abort();
    expect(jobs.enter({ signal: spent.signal }).signal.aborted).toBe(true);
  });

  it("lets go of work that is over: a later cancel or abort does not touch it", () => {
    const jobs = new InFlightJobs();
    const live = new AbortController();
    const work = jobs.enter({ jobId: "a", signal: live.signal });
    work.release();
    work.release();
    jobs.cancel("a");
    live.abort();
    expect(work.signal.aborted).toBe(false);
  });
});
