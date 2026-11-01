import { TestBed } from "@angular/core/testing";
import { AuthStore } from "./auth.store";

describe("AuthStore", () => {
  let store: AuthStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(AuthStore);
  });

  it("starts disconnected with no key material", () => {
    expect(store.isConnected()).toBe(false);
    expect(store.apiKey()).toBeNull();
    expect(store.keyPrefix()).toBe("");
  });

  it("keeps the key in memory and exposes only a masked prefix", () => {
    store.connect("hb_live_abcdefghijklmnop", "http://localhost:3100");
    expect(store.isConnected()).toBe(true);
    expect(store.apiKey()).toBe("hb_live_abcdefghijklmnop");
    expect(store.keyPrefix()).toBe("hb_liv\u2026mnop");
    expect(store.state().baseUrl).toBe("http://localhost:3100");
  });

  it("trims surrounding whitespace from a pasted key", () => {
    store.connect("  hb_live_abcdefghijklmnop  ");
    expect(store.apiKey()).toBe("hb_live_abcdefghijklmnop");
  });

  it("records why a session died so the connect screen can explain it", () => {
    store.connect("hb_live_abcdefghijklmnop");
    store.invalidate("unauthorized", "Key revoked by an administrator.");
    expect(store.isConnected()).toBe(false);
    expect(store.apiKey()).toBeNull();
    expect(store.failure()).toBe("unauthorized");
    expect(store.state().failureDetail).toContain("revoked");
  });

  it("ignores invalidation when nothing is connected", () => {
    store.invalidate("unauthorized", "stale 401");
    expect(store.failure()).toBeNull();
    expect(store.state().failureDetail).toBeNull();
  });

  it("never reports a negative in-flight count", () => {
    store.noteRequest();
    store.noteRequest();
    expect(store.inFlight()).toBe(2);
    store.noteResponse();
    store.noteResponse();
    store.noteResponse();
    expect(store.inFlight()).toBe(0);
  });

  it("clears everything on an explicit disconnect", () => {
    store.connect("hb_live_abcdefghijklmnop");
    store.noteRequest();
    store.disconnect();
    expect(store.isConnected()).toBe(false);
    expect(store.apiKey()).toBeNull();
    expect(store.keyPrefix()).toBe("");
    expect(store.failure()).toBeNull();
  });
});
