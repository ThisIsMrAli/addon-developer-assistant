/**
 * A fetch that never settles and holds a socket open.
 * Used to prove `develop.mjs docs` still exits after the budget.
 */
import net from "node:net";

const server = net.createServer(() => {});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const port = server.address().port;

globalThis.fetch = () => new Promise(() => {
  net.connect(port, "127.0.0.1");
});
