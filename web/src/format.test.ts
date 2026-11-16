import { describe, expect, it } from "vitest";
import { ago, countdown, flagLabel, naira, pct, short, toUnits, tusd8, wat } from "./format";

describe("format", () => {
  it("tUSD8 amounts", () => {
    expect(tusd8("20000")).toBe("0.02 tUSD8");
    expect(tusd8(1_500_000n)).toBe("1.50 tUSD8");
    expect(tusd8("209670", { symbol: false })).toBe("0.20967");
    expect(tusd8("0")).toBe("0.00 tUSD8");
  });
  it("naira approximation at the demo rate", () => {
    expect(naira("20000", 1500)).toBe("₦30");
    expect(naira("1000000", 1500)).toBe("₦1,500");
  });
  it("parses typed amounts strictly", () => {
    expect(toUnits("0.05")).toBe(50_000n);
    expect(toUnits("1")).toBe(1_000_000n);
    expect(toUnits("-1")).toBeNull();
    expect(toUnits("0.0000001")).toBeNull();
    expect(toUnits("1e3")).toBeNull();
  });
  it("time helpers", () => {
    const now = Date.parse("2026-11-16T10:00:00Z");
    expect(countdown(now / 1000 + 2 * 86400 + 3600, now)).toBe("2d 1h left");
    expect(countdown(now / 1000 - 1, now)).toBe("expired");
    expect(ago("2026-11-16T09:58:00Z", now)).toBe("2 min ago");
    expect(wat("2026-11-16T10:06:21Z")).toBe("16 Nov, 11:06 WAT");
  });
  it("misc", () => {
    expect(short("0x0C9bce6c93765Ad41243141f936A4eA59A04272F")).toBe("0x0C9b…272F");
    expect(pct(30_000n, 60_000n)).toBe(50);
    expect(flagLabel("payee:lookalike")).toBe("Look-alike name");
    expect(flagLabel("foreign-address:0x0000…bad1")).toBe("Unknown wallet 0x0000…bad1");
  });
});
