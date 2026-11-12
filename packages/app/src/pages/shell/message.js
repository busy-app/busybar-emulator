// The shell's message page. The text comes from the main process over the bridge and is shown as text.
const bridge = window.busyShell;

async function show() {
  const message = await bridge.message();
  document.getElementById("title").textContent = message.title;
  document.getElementById("text").textContent = message.text;
  const detail = document.getElementById("detail");
  detail.textContent = message.detail ?? "";
  detail.hidden = !message.detail;
  for (const name of ["retry", "quit"]) document.getElementById(name).hidden = !message.actions.includes(name);
  document.body.dataset.kind = message.kind;
}

document.getElementById("retry").addEventListener("click", () => bridge.retry());
document.getElementById("quit").addEventListener("click", () => bridge.quit());
show();
