import { describe, expect, it } from "vitest";
import { InputError } from "../errors.js";
import { takenRange, wallClock, zonedToUtc } from "../library/dates.js";

const CHICAGO = "America/Chicago";

describe("zonedToUtc", () => {
  it("converts local midnight on both sides of DST", () => {
    expect(zonedToUtc(2024, 1, 15, CHICAGO).toISOString()).toBe("2024-01-15T06:00:00.000Z");
    expect(zonedToUtc(2024, 7, 15, CHICAGO).toISOString()).toBe("2024-07-15T05:00:00.000Z");
  });

  it("handles the DST transition days themselves", () => {
    // 2024-03-10: clocks jump 02:00 -> 03:00; midnight is still CST.
    expect(zonedToUtc(2024, 3, 10, CHICAGO).toISOString()).toBe("2024-03-10T06:00:00.000Z");
    expect(zonedToUtc(2024, 3, 11, CHICAGO).toISOString()).toBe("2024-03-11T05:00:00.000Z");
    // 2024-11-03: clocks fall back; midnight is still CDT.
    expect(zonedToUtc(2024, 11, 3, CHICAGO).toISOString()).toBe("2024-11-03T05:00:00.000Z");
    expect(zonedToUtc(2024, 11, 4, CHICAGO).toISOString()).toBe("2024-11-04T06:00:00.000Z");
  });

  it("is the identity in UTC and works east of it", () => {
    expect(zonedToUtc(2024, 6, 1, "UTC").toISOString()).toBe("2024-06-01T00:00:00.000Z");
    expect(zonedToUtc(2024, 6, 1, "Asia/Tokyo").toISOString()).toBe("2024-05-31T15:00:00.000Z");
  });
});

describe("takenRange", () => {
  it("is undefined when neither bound is given", () => {
    expect(takenRange(undefined, undefined, CHICAGO)).toBeUndefined();
    expect(takenRange("", "", CHICAGO)).toBeUndefined();
  });

  it("treats a bare year, month or day as a whole local period, both ends inclusive", () => {
    expect(takenRange("2024", "2024", CHICAGO)).toEqual({
      gte: "2024-01-01T06:00:00.000Z",
      lt: "2025-01-01T06:00:00.000Z",
    });
    expect(takenRange("2024-12", "2024-12", "UTC")).toEqual({
      gte: "2024-12-01T00:00:00.000Z",
      lt: "2025-01-01T00:00:00.000Z",
    });
    expect(takenRange("2024-02-29", "2024-02-29", "UTC")).toEqual({
      gte: "2024-02-29T00:00:00.000Z",
      lt: "2024-03-01T00:00:00.000Z",
    });
  });

  it("accepts open-ended ranges", () => {
    expect(takenRange("2024-06", undefined, "UTC")).toEqual({ gte: "2024-06-01T00:00:00.000Z" });
    expect(takenRange(undefined, "2024-06-30", "UTC")).toEqual({ lt: "2024-07-01T00:00:00.000Z" });
  });

  it("keeps an explicit offset and reads a bare timestamp in the configured zone", () => {
    expect(takenRange("2024-06-15T18:00:00Z", "2024-06-15T20:30:00+02:00", CHICAGO)).toEqual({
      gte: "2024-06-15T18:00:00.000Z",
      lte: "2024-06-15T18:30:00.000Z",
    });
    expect(takenRange("2024-06-15T18:00", undefined, CHICAGO)).toEqual({
      gte: "2024-06-15T23:00:00.000Z",
    });
  });

  it.each(["June 2024", "2024-13", "2024-02-30", "24-06-01", "2024/06/01", "yesterday", "0024"])(
    "rejects %s with a hint at the accepted forms",
    (value) => {
      expect(() => takenRange(value, undefined, "UTC")).toThrow(InputError);
      expect(() => takenRange(value, undefined, "UTC")).toThrow(/YYYY-MM-DD/);
    },
  );

  it("rejects an inverted range", () => {
    expect(() => takenRange("2025", "2024", "UTC")).toThrow("must be before");
  });
});

describe("wallClock", () => {
  it("drops the misleading zone and the milliseconds", () => {
    expect(wallClock("2024-06-15T07:12:00.123Z")).toBe("2024-06-15T07:12:00");
    expect(wallClock("2024-06-15T07:12:00+00:00")).toBe("2024-06-15T07:12:00");
    expect(wallClock("2024-06-15T07:12:00")).toBe("2024-06-15T07:12:00");
  });
});
