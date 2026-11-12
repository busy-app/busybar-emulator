import { device } from "@shared/device";

/**
 * One thing on a display, in the bar's own words (POST /api/display/draw): a text, an image, an animation, a
 * countdown or a rectangle, placed by x, y and align. `display: "back"` puts it on the back display.
 */
export type Element = Record<string, unknown> & { id: string };

/**
 * Draws screens by sending only what changed since the last one.
 *
 * Every call to the bar is an HTTP request its web server handles, so a second-by-second counter should cost one
 * small element, not the whole screen. The screen remembers what it sent by element id; `draw(elements)` sends the
 * elements whose description changed and removes the ones that are gone.
 */
export function createScreen(app: string) {
  /** What is on the displays now, by element id. */
  const shown = new Map<string, string>();
  /** Draws run one after another; a request made meanwhile is folded into the next. */
  let busy = false;
  let next: { elements: Element[]; led: string | null } | null = null;

  async function send(elements: Element[], led: string | null): Promise<void> {
    const request = { application_name: app, priority: 50, elements, ...(led ? { led_notification_color: led } : {}) };
    // busy-lib's element types are stricter than the firmware about optional fields; the shapes here follow the firmware.
    await device.DisplayDraw(request as never);
  }

  async function once(elements: Element[], led: string | null): Promise<void> {
    const changed = elements.filter((e) => shown.get(e.id) !== JSON.stringify(e));
    const present = new Set(elements.map((e) => e.id));
    const gone = [...shown.keys()].filter((id) => !present.has(id));
    try {
      if (gone.length > 0) await device.DisplayClear({ application_name: app, element_ids: gone });
      // A blink of the light needs a draw request to ride on: the first element is sent again.
      if (led && changed.length === 0 && elements.length > 0) changed.push(elements[0]!);
      if (changed.length > 0) await send(changed, led);
    } catch (err) {
      // Firmware 1.3.1 refuses a whole delete when one of its ids is already gone (a short Back clears the app's
      // screen there), and an element cannot change its type under the same id. Either way: start from nothing.
      console.error(`${app}: drawing everything again: ${err instanceof Error ? err.message : String(err)}`);
      shown.clear();
      await device.DisplayClear({ application_name: app });
      if (elements.length > 0) await send(elements, led);
    }
    shown.clear();
    for (const e of elements) shown.set(e.id, JSON.stringify(e));
  }

  return {
    /**
     * Shows exactly these elements. `led` (#RRGGBBAA) also blinks the bar's light. Errors are reported, not thrown:
     * one failed request must not stop the app.
     */
    async draw(elements: Element[], led: string | null = null): Promise<void> {
      next = { elements, led: led ?? next?.led ?? null };
      if (busy) return;
      busy = true;
      while (next) {
        const { elements: now, led: light } = next;
        next = null;
        await once(now, light).catch((err: unknown) => console.error(`${app}: ${err instanceof Error ? err.message : String(err)}`));
      }
      busy = false;
    },
    /** Forgets what was sent, so the next draw sends everything: after a short Back, which clears the screen on 1.3.1. */
    forget(): void {
      shown.clear();
    },
  };
}
