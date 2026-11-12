// Source edits the screen module needs to compile with clang: the firmware is built with GCC and uses its nested
// functions and ARM inline assembly. Each edit keeps the behavior: nested functions become static functions with
// their captures passed through a context, the assembly becomes the arithmetic it performs. The build applies them to
// copies in build/gen and stops if a `find` no longer matches, so an upstream change is never silently patched over.
// Three edits are not about clang: the runtime's JerryScript counts the byte-code instructions it executes and the bytes
// it allocates on its heap, which bar speed (packages/server/bar-speed.mjs) turns into the bar's time, and it asks the
// emulator's watchdog between promise jobs as well as at backward branches.
//
// path (relative to busybar-firmware) → [find, replace][]

// A settings program's main function: its loop, then the clean-up (see apps_menu.c below). `between` is what stands
// between the two in the firmware's source.
const settingsMain = (entry, free, { indent = "    ", between = "" } = {}) => [
  [entry, `#include <shim.h>\n${entry}`],
  [
    `${indent}furi_event_loop_run(instance->event_loop);\n${between}${indent}${free}(instance);`,
    `${indent}emu_event_loop_run_then(instance->event_loop, (void (*)(void*))${free}, instance);`,
  ],
];
// Most of them take their thread's signal callback off first; a thread that is over gets no signals here.
const unsignal = "    furi_thread_set_signal_callback(thread, NULL, NULL);\n";

export const patches = {
  "applications/main/settings_menu/settings.c": settingsMain("int32_t settings_app(void* arg) {", "settings_free"),
  "applications/settings/about/about.c": settingsMain("int32_t about_entry(void* arg) {", "about_free", { between: unsignal }),
  "applications/settings/account_settings/account_settings.c": settingsMain("int32_t account_settings_entry(void* arg) {", "account_settings_free", { between: unsignal }),
  "applications/settings/ble_settings/ble_settings.c": settingsMain("int32_t ble_settings_entry(void* arg) {", "ble_settings_free"),
  "applications/settings/brightness_settings/brightness_settings.c": settingsMain("int32_t brightness_settings_entry(void* arg) {", "brightness_settings_free", { between: unsignal }),
  "applications/settings/debug_app_list/debug_app_list.c": settingsMain("int32_t debug_app_list_entry(void* arg) {", "debug_app_list_free", { between: unsignal }),
  "applications/settings/firmware/firmware.c": settingsMain("int32_t firmware_settings_entry(void* argument) {", "firmware_settings_free", { indent: "        ", between: "\n" }),
  "applications/settings/matter_settings/matter_settings.c": settingsMain("int32_t matter_settings_entry(void* arg) {", "matter_settings_free", { between: unsignal }),
  "applications/settings/sound_settings/sound_settings.c": settingsMain("int32_t sound_settings_entry(void* arg) {", "sound_settings_free", { between: unsignal }),
  "applications/settings/system_settings/system_settings.c": settingsMain("int32_t system_settings_entry(void* arg) {", "system_settings_free", { between: unsignal }),
  "applications/settings/time_settings/time_settings.c": settingsMain("int32_t time_settings_entry(void* arg) {", "time_settings_free", { between: unsignal }),
  "applications/settings/wifi_settings/wifi_settings.c": settingsMain("int32_t wifi_settings_entry(void* arg) {", "wifi_settings_free", { between: unsignal }),

  "lib/jerryscript/amalgam/jerryscript.c": [
    [
      `      const uint8_t *byte_code_start_p = byte_code_p;
      uint8_t opcode = *byte_code_p++;`,
      `      const uint8_t *byte_code_start_p = byte_code_p;
      extern uint32_t emu_vm_ops; /* native/emu_runner.c */
      emu_vm_ops++;
      uint8_t opcode = *byte_code_p++;`,
    ],
    [
      `jmem_heap_alloc (const size_t size) /**< size of requested block */
{`,
      `jmem_heap_alloc (const size_t size) /**< size of requested block */
{
  extern uint32_t emu_alloc_bytes; /* native/emu_runner.c */
  emu_alloc_bytes += (uint32_t) size;`,
    ],
    // The emulator's watchdog (emu_runner.c engine_halt_callback) is asked at backward branches only, where JerryScript
    // asks its halt handler. A chain of promise reactions that never ends (a .then() that starts the next one, an async
    // function that calls itself after an await) has none: the job queue below never empties, and the app's JS held
    // the server's thread for good (Tasks for Notion without a token, 12.11). So the halt handler is also asked before
    // each job, and its stop ends the queue as it ends a loop; the jobs left are freed with the context.
    [
      `  while (JERRY_CONTEXT (job_queue_head_p) != NULL)
  {
    ecma_job_queue_item_t *job_p = JERRY_CONTEXT (job_queue_head_p);
    JERRY_CONTEXT (job_queue_head_p) = ecma_job_queue_get_next (job_p);

    ecma_fast_free_value (ret);
`,
      `  while (JERRY_CONTEXT (job_queue_head_p) != NULL)
  {
#if JERRY_VM_HALT
    if (JERRY_CONTEXT (vm_exec_stop_cb) != NULL && --JERRY_CONTEXT (vm_exec_stop_counter) == 0)
    {
      ecma_value_t stop = JERRY_CONTEXT (vm_exec_stop_cb) (JERRY_CONTEXT (vm_exec_stop_user_p));

      if (ecma_is_value_undefined (stop))
      {
        JERRY_CONTEXT (vm_exec_stop_counter) = JERRY_CONTEXT (vm_exec_stop_frequency);
      }
      else
      {
        JERRY_CONTEXT (vm_exec_stop_counter) = 1;
        ecma_fast_free_value (ret);

        if (ecma_is_value_exception (stop))
        {
          ecma_throw_exception (stop);
        }
        else
        {
          jcontext_raise_exception (stop);
        }

        jcontext_set_abort_flag (true);
        return ECMA_VALUE_ERROR;
      }
    }
#endif /* JERRY_VM_HALT */

    ecma_job_queue_item_t *job_p = JERRY_CONTEXT (job_queue_head_p);
    JERRY_CONTEXT (job_queue_head_p) = ecma_job_queue_get_next (job_p);

    ecma_fast_free_value (ret);
`,
    ],
  ],
  "applications/services/canvas/canvas.c": [
    [
      `static void canvas_reorder_elements(CanvasSrv* canvas) {`,
      `static int compare_z_index(const void* untyped_a, const void* untyped_b) {
    CanvasWidget* const* a = untyped_a;
    CanvasWidget* const* b = untyped_b;
    return (*a)->z_index - (*b)->z_index;
}

static void canvas_reorder_elements(CanvasSrv* canvas) {`,
    ],
    [
      `    int compare_z_index(const void* untyped_a, const void* untyped_b) {
        CanvasWidget* const* a = untyped_a;
        CanvasWidget* const* b = untyped_b;
        return (*a)->z_index - (*b)->z_index;
    }
`,
      ``,
    ],
  ],

  "lib/anim_file/anim_file.c": [
    [
      `bool FURI_WARN_UNUSED
    anim_file_set_section(`,
      `typedef struct {
    const char* name;
    const AnimFileSection* section;
} EmuSectionSearch;

static void emu_section_search(size_t cur_index, const AnimFileSection* cur_section, void* context) {
    UNUSED(cur_index);
    EmuSectionSearch* search = context;
    if(strcmp(cur_section->name, search->name) == 0) search->section = cur_section;
}

bool FURI_WARN_UNUSED
    anim_file_set_section(`,
    ],
    [
      `    void callback(size_t cur_index, const AnimFileSection* cur_section, void* context) {
        UNUSED(cur_index);
        UNUSED(context);
        if(strcmp(cur_section->name, name) == 0) section = cur_section;
    }

    if(!anim_file_load_iterate_sections(header, sections, callback, &section)) return false;
`,
      `    EmuSectionSearch search = {.name = name, .section = NULL};
    if(!anim_file_load_iterate_sections(header, sections, emu_section_search, &search)) return false;
    section = search.section;
`,
    ],
  ],

  "lib/anim_file/components/anim_file_img.c": [
    [
      `static bool anim_file_img_step_decode_qoi(`,
      `static inline size_t pixel_hash(uint32_t pixel) {
    size_t a = (pixel >> 24) & 0xff;
    size_t r = (pixel >> 16) & 0xff;
    size_t g = (pixel >> 8) & 0xff;
    size_t b = pixel & 0xff;
    return ((r * 3) + (g * 5) + (b * 7) + (a * 11)) % 64;
}

static inline uint8_t wrapping_add8(uint8_t old, int8_t diff) {
    return (uint8_t)(((int)old + (int)diff) & 0xff);
}

// The argument is evaluated once, before anything changes, as for the nested function it replaces.
#define output_pixel(pixel_value)                            \\
    do {                                                     \\
        uint32_t emu_pixel = (pixel_value);                  \\
        hash_lut[pixel_hash(emu_pixel)] = emu_pixel;         \\
        last_px = emu_pixel;                                 \\
        if(dest_pixels < max_pixels) dest_buf[dest_pixels] = emu_pixel; \\
        dest_pixels++;                                       \\
    } while(0)

static bool anim_file_img_step_decode_qoi(`,
    ],
    [
      `    inline size_t pixel_hash(uint32_t pixel) {
        size_t a = (pixel >> 24) & 0xff;
        size_t r = (pixel >> 16) & 0xff;
        size_t g = (pixel >> 8) & 0xff;
        size_t b = pixel & 0xff;
        return ((r * 3) + (g * 5) + (b * 7) + (a * 11)) % 64;
    }

    inline void output_pixel(uint32_t pixel) {
        hash_lut[pixel_hash(pixel)] = pixel;
        last_px = pixel;
        if(dest_pixels < max_pixels) dest_buf[dest_pixels] = pixel;
        dest_pixels++;
    }

    inline uint8_t wrapping_add8(uint8_t old, int8_t diff) {
        return (uint8_t)(((int)old + (int)diff) & 0xff);
    }
`,
      ``,
    ],
    [
      `static AnimFileBuffer* anim_file_img_step_disperse(`,
      `#undef output_pixel

typedef struct {
    bool margin_needed;
    size_t half_margin;
    size_t effective_w;
    AnimFileBuffer* destination;
    uint32_t* src_pixel;
    size_t src_pixels_left;
    size_t src_pixels_overrun;
} EmuPlacePixels;

static void place_pixels(AnimFileMaskPixelRange range, void* context) {
    EmuPlacePixels* c = context;

    if(c->margin_needed) {
        range.y += c->half_margin;
        range.x_start += c->half_margin;
        range.x_end += c->half_margin;
    }

    size_t start_idx = (range.y * c->effective_w) + range.x_start;
    uint32_t* dst_start = (uint32_t*)(c->destination->data + (start_idx * sizeof(uint32_t)));

    size_t wanted_pixel_cnt = range.x_end - range.x_start;
    size_t pixel_cnt = MIN(wanted_pixel_cnt, c->src_pixels_left);
    if(wanted_pixel_cnt > c->src_pixels_left)
        c->src_pixels_overrun += (wanted_pixel_cnt - c->src_pixels_left);

    memcpy(dst_start, c->src_pixel, pixel_cnt * ANIM_FILE_OUT_BYTES_PER_PIXEL);
    c->src_pixel += pixel_cnt;
    c->src_pixels_left -= pixel_cnt;
}

static AnimFileBuffer* anim_file_img_step_disperse(`,
    ],
    [
      `    void place_pixels(AnimFileMaskPixelRange range, void* context) {
        UNUSED(context);

        if(margin_needed) {
            range.y += half_margin;
            range.x_start += half_margin;
            range.x_end += half_margin;
        }

        size_t start_idx = (range.y * effective_w) + range.x_start;
        uint32_t* dst_start = (uint32_t*)(destination->data + (start_idx * sizeof(uint32_t)));

        size_t wanted_pixel_cnt = range.x_end - range.x_start;
        size_t pixel_cnt = MIN(wanted_pixel_cnt, src_pixels_left);
        if(wanted_pixel_cnt > src_pixels_left)
            src_pixels_overrun += (wanted_pixel_cnt - src_pixels_left);

#ifdef ANIM_FILE_SHOW_MASK_INSTEAD_OF_IMAGE
        memset(dst_start, 0xff, wanted_pixel_cnt * ANIM_FILE_OUT_BYTES_PER_PIXEL);
#else
        memcpy(dst_start, src_pixel, pixel_cnt * ANIM_FILE_OUT_BYTES_PER_PIXEL);
#endif
        src_pixel += pixel_cnt;
        src_pixels_left -= pixel_cnt;
    }

    anim_file_mask_iterate(anim, frame_hdr, place_pixels, NULL);
`,
      `    EmuPlacePixels place = {
        .margin_needed = margin_needed,
        .half_margin = half_margin,
        .effective_w = effective_w,
        .destination = destination,
        .src_pixel = src_pixel,
        .src_pixels_left = src_pixels_left,
        .src_pixels_overrun = src_pixels_overrun,
    };
    anim_file_mask_iterate(anim, frame_hdr, place_pixels, &place);
    src_pixel = place.src_pixel;
    src_pixels_left = place.src_pixels_left;
    src_pixels_overrun = place.src_pixels_overrun;
`,
    ],
  ],

// An app's main function runs its loop and then cleans up on the same thread. The emulator's loops do not block, so
  // the clean-up is handed over to run once the loop is stopped (emu_event_loop_run_then in furi_shim.c).
  "applications/main/apps_menu/apps_menu.c": [
    [`#include "apps_menu.h"`, `#include "apps_menu.h"
#include <shim.h>`],
    [
      `    if(instance) {
        furi_event_loop_run(instance->event_loop);
        apps_menu_free(instance);
    }`,
      `    if(instance) {
        emu_event_loop_run_then(instance->event_loop, (void (*)(void*))apps_menu_free, instance);
    }`,
    ],
  ],

  // The APPS screen with no apps sends the author to the bar's USB address, which the emulator does not have: it names
  // the address the emulated bar answers on instead, as the host gives it when the screen opens (host_bar_address).
  // Without one (a host that has no server) the firmware's own text stays.
  "applications/main/apps_menu/scenes/apps_menu_scene_empty.c": [
    [`#include <gui/modules/status_view.h>`, `#include <gui/modules/status_view.h>
#include <host.h>
#include <stdlib.h>
#include <string.h>`],
    [
      `        status_view_set_primary_text(data->front_status, "No apps yet, go to\\nhttp://10.0.4.20");`,
      `        char* emu_address = host_bar_address();
        FuriString* emu_text = furi_string_alloc();
        if(emu_address) {
            // The front's tiny font fits the address without its scheme: "127.0.0.1:8640".
            const char* emu_host = strncmp(emu_address, "http://", 7) == 0 ? emu_address + 7 : emu_address;
            furi_string_printf(emu_text, "No apps yet, go to\\n%s", emu_host);
        } else {
            furi_string_set(emu_text, "No apps yet, go to\\nhttp://10.0.4.20");
        }
        status_view_set_primary_text(data->front_status, furi_string_get_cstr(emu_text));`,
    ],
    [
      `        status_view_set_primary_text(data->back_status, "No apps yet. Add via http://10.0.4.20");`,
      `        if(emu_address) {
            furi_string_printf(emu_text, "No apps yet. Add via %s", emu_address);
        } else {
            furi_string_set(emu_text, "No apps yet. Add via http://10.0.4.20");
        }
        status_view_set_primary_text(data->back_status, furi_string_get_cstr(emu_text));
        furi_string_free(emu_text);
        free(emu_address);`,
    ],
  ],

  "applications/main/busy/busy.c": [
    [`#include "busy_presets.h"`, `#include "busy_presets.h"
#include <shim.h>`],
    [
      `    BusyApp* instance = busy_alloc(arg);
    furi_event_loop_run(instance->event_loop);
    busy_free(instance);`,
      `    BusyApp* instance = busy_alloc(arg);
    emu_event_loop_run_then(instance->event_loop, (void (*)(void*))busy_free, instance);`,
    ],
  ],

  "applications/system/js_app_launcher/js_app_launcher.c": [
    [`#include <web_server/web_server.h>`, `#include <web_server/web_server.h>
#include <shim.h>`],
    [
      `    JsAppLauncher* instance = js_app_launcher_alloc(arg);
    furi_event_loop_run(instance->event_loop);
    js_app_launcher_free(instance);`,
      `    JsAppLauncher* instance = js_app_launcher_alloc(arg);
    emu_event_loop_run_then(instance->event_loop, (void (*)(void*))js_app_launcher_free, instance);`,
    ],
  ],

  // smlabb accumulates (int16 channel) × (int16 kernel) into each channel's sum; the bfi sequence packs bits 8..15 of
  // each sum into one byte of the pixel, which is (sum >> 8) & 0xff.
  "lib/toolbox/dsp.c": [
    [
      `            __asm__ volatile(
                // 1. extract blue channel; 2. add to corresponding running sum
                "uxtb %[chan], %[px], ror #0\\n" // Unsigned Extend Byte
                "smlabb %[ab], %[chan], %[krnl], %[ab]\\n" // Signed Multiply-Accumulate Bottom with Bottom halfwords
                // repeat for other channels:
                "uxtb %[chan], %[px], ror #8\\n"
                "smlabb %[ag], %[chan], %[krnl], %[ag]\\n"
                "uxtb %[chan], %[px], ror #16\\n"
                "smlabb %[ar], %[chan], %[krnl], %[ar]\\n"
                "uxtb %[chan], %[px], ror #24\\n"
                "smlabb %[aa], %[chan], %[krnl], %[aa]\\n"
                :
                // both input and output
                [ab] "+&r"(ab),
                [ag] "+&r"(ag),
                [ar] "+&r"(ar),
                [aa] "+&r"(aa),
                // temporary register
                [chan] "=&r"(chan)
                :
                // inputs
                [px] "r"(px),
                [krnl] "r"(krnl));`,
      `            int32_t k = (int16_t)(krnl & 0xffff);
            ab += (uint32_t)((int32_t)(px & 0xff) * k);
            ag += (uint32_t)((int32_t)((px >> 8) & 0xff) * k);
            ar += (uint32_t)((int32_t)((px >> 16) & 0xff) * k);
            aa += (uint32_t)((int32_t)((px >> 24) & 0xff) * k);
            (void)chan;`,
    ],
    [
      `    __asm__ volatile(
        // pack 8-bit values into 32-bit, while diving by 256
        "bfi %[px], %[aa], #16, #16\\n" // Bitfield Insert
        "bfi %[px], %[ar], #8, #16\\n"
        "bfi %[px], %[ag], #0, #16\\n"
        "lsr %[ab], %[ab], #8\\n" // Logical Shift Left
        "bfi %[px], %[ab], #0, #8\\n"
        :
        // internal temporary
        [px] "=&r"(px)
        :
        // input only
        [ab] "r"(ab),
        [ag] "r"(ag),
        [ar] "r"(ar),
        [aa] "r"(aa));`,
      `    px = (((aa >> 8) & 0xff) << 24) | (((ar >> 8) & 0xff) << 16) | (((ag >> 8) & 0xff) << 8) | ((ab >> 8) & 0xff);`,
    ],
  ],
};
