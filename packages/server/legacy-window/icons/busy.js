// BUSY's own interface icons (icons/busy, 24 by 24, one color) for the pages of the device window.
//
//   <script src="/emulator/icons/busy.js"></script>
//   button.append(busyIcon("refresh"));              an <svg> element, as large as the text around it (1em),
//                                                    in the text's color, hidden from screen readers
//   busyIcon("wifi-4", { size: 20 })                 20 pixels; any CSS length as a string works too ("1.25em")
//   busyIcon("alert", { label: "Warning" })          named for a screen reader instead of hidden
//   busyIcon.html("usb")                             the same as a string, for a template
//   busyIcon.names()                                 a promise of every name, from icons/busy/index.json
//   busyIcon.frames()                                a promise of the names by frame of BUSY's set: { arrows: [...] }
//
// Every icon comes from one file, icons/busy-sprite.svg, which the page asks for once: each <svg> points into it
// with <use>. The names are those of icons/busy/<name>.svg. An icon's badge (connected, charging) has the icon's
// color unless the page sets the CSS variable --bi-accent on the icon or around it.
//
// No import and no export: the file works as a plain script and as a module, and sets busyIcon on globalThis.
(() => {
  const SPRITE = "/emulator/icons/busy-sprite.svg";
  const INDEX = "/emulator/icons/busy/index.json";
  const SVG = "http://www.w3.org/2000/svg";
  const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  const length = (size) => (typeof size === "number" ? `${size}px` : String(size));
  const checked = (name) => {
    if (typeof name !== "string" || !NAME.test(name)) throw new Error(`busyIcon: "${name}" is not an icon's name`);
    return name;
  };
  const escaped = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  /** The icon as an <svg> element. */
  function busyIcon(name, { size = "1em", label } = {}) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", `bi bi-${checked(name)}`);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", length(size));
    svg.setAttribute("height", length(size));
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("focusable", "false");
    if (label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
    } else svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG, "use");
    use.setAttribute("href", `${SPRITE}#bi-${name}`);
    svg.append(use);
    return svg;
  }

  /** The icon as a string of HTML. */
  busyIcon.html = (name, { size = "1em", label } = {}) => {
    const named = label ? `role="img" aria-label="${escaped(label)}"` : 'aria-hidden="true"';
    return `<svg class="bi bi-${checked(name)}" viewBox="0 0 24 24" width="${escaped(length(size))}" height="${escaped(length(size))}" fill="currentColor" focusable="false" ${named}><use href="${SPRITE}#bi-${name}"/></svg>`;
  };

  let frames = null;
  /** The names by frame of BUSY's set (a frame is a category): { arrows: ["arrow-down", ...], ... }. */
  busyIcon.frames = () => (frames ??= fetch(INDEX).then((response) => response.json()));
  /** Every icon's name, in the alphabet's order. */
  busyIcon.names = () => busyIcon.frames().then((index) => Object.values(index).flat().sort());

  busyIcon.sprite = SPRITE;
  globalThis.busyIcon = busyIcon;
})();
