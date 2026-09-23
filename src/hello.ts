import type { FastifyInstance } from "fastify";

const HELLO_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hello World</title>
<style>
:root {
  color-scheme: light;
  --ink: #101820;
  --muted: #5a6872;
  --fog: #f1f5f7;
  --paper: #fbfcfc;
  --line: #d6dfe3;
  --blue: #165dcc;
  --radius: 14px;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  background: var(--fog);
  color: var(--ink);
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: var(--fog); }
.shell { width: min(560px, calc(100% - 40px)); margin: 0 auto; padding: 48px 0 32px; }
.panel { display: grid; gap: 18px; justify-items: center; padding: 32px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: 0 10px 35px rgba(30, 45, 55, .045); text-align: center; }
h1 { margin: 0; font-family: "Arial Narrow", "Avenir Next Condensed", "Segoe UI", sans-serif; font-size: clamp(36px, 8vw, 56px); font-weight: 800; letter-spacing: -.035em; }
#hello-count { margin: 0; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 36px; font-weight: 800; color: var(--ink); }
button { min-width: 44px; min-height: 44px; padding: 12px 22px; border: 0; border-radius: 10px; background: var(--blue); color: #fff; font-family: "Avenir Next", "Segoe UI", sans-serif; font-size: 15px; font-weight: 650; cursor: pointer; }
button:focus-visible { outline: 3px solid #72a7ff; outline-offset: 3px; }
</style>
</head>
<body>
<main class="shell">
  <section class="panel">
    <h1>Hello World</h1>
    <p id="hello-count" data-testid="hello-count">0</p>
    <button type="button" id="hello-increment">Increase count</button>
  </section>
</main>
<script>
(function () {
  var STORAGE_KEY = "flowHelloCount";
  var countElement = document.getElementById("hello-count");
  var button = document.getElementById("hello-increment");
  var stored = window.localStorage.getItem(STORAGE_KEY);
  var count = stored === null ? 0 : parseInt(stored, 10);
  if (!Number.isFinite(count)) count = 0;
  countElement.textContent = String(count);
  button.addEventListener("click", function () {
    count += 1;
    countElement.textContent = String(count);
    window.localStorage.setItem(STORAGE_KEY, String(count));
  });
})();
</script>
</body>
</html>
`;

export const registerHelloRoute = (server: FastifyInstance): void => {
  server.get("/hello", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(HELLO_PAGE));
};
