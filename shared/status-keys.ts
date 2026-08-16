// Status-entry keys: each owning extension publishes under its key and the
// adaptive footer reads them to place or suppress the entries it renders itself.

export const AUTO_COMPACT_STATUS_KEY = "auto-compact";
export const ELAPSED_TIME_STATUS_KEY = "elapsed-time";
export const FAST_OPENAI_STATUS_KEY = "fast-openai";
// The fast-openai status is always published while the extension is running,
// so consumers can tell "fast is off" apart from "fast-openai is not loaded"
// (key absent).
export const FAST_OPENAI_STATUS_ON = "on";
export const FAST_OPENAI_STATUS_OFF = "off";
