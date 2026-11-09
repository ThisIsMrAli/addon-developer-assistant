/** Fails the process if any code calls fetch. Used to prove `begin` stays offline. */
globalThis.fetch = () => {
  throw new Error("network called");
};
