// The emulator side of the screen module: the firmware's GUI, canvas and display API run unchanged on top of this.
//
// emu_screen_init() starts the services the way the bar does (font registry, GUI, canvas, then the desktop with the
// apps menu, see emu_system.c) after creating the records they open. The host then:
//   - calls emu_tick() every 8 ms, the GUI's tick, which runs LVGL's timers: refresh, scrolling text, animations;
//   - passes /api/display/* requests to emu_screen_request(); api_display.c answers into a mongoose connection whose
//     send buffer the host reads. A draw is answered later, when canvas has handled it (at once, or after up to
//     1.5 s for a lower priority one), so the host waits for host_reply_ready();
//   - reads frames with emu_screen_frame(), exactly what GET /api/screen returns on the bar;
//   - forwards key presses with emu_screen_input(), and launches and quits apps through the JS app launcher
//     (emu_screen_launch, emu_screen_quit in emu_system.c), which runs them in the runtime module.
// The display drivers and power are stand-ins that do nothing the screen depends on; the status lights tell the host
// what the firmware lights them with.
#include <furi.h>
#include <furi_hal_rtc.h>

#include <back_display/back_display.h>
#include <brightness_control/brightness_control.h>
#include <canvas/canvas.h>
#include <front_display/front_display.h>
#include <gui/gui.h>
#include <gui/gui_i.h>
#include <input/input.h>
#include <loader/loader.h>
#include <low_power/low_power.h>
#include <status_lights/status_lights.h>
#include <toolbox/color.h>
#include <lvgl.h>
#include <web_server/http_api/http_api.h>

#include <emscripten.h>
#include <string.h>

#include "host.h"
#include "shim.h"

int32_t gui_srv(void* arg);
int32_t canvas_service_start(void* arg);
int font_registry_startup(void* arg);
int32_t status_bar_srv(void* arg);
int32_t supervisor_start(void* arg);
void emu_status_init(void);
void emu_system_init(void);
void emu_system_start(void);
void emu_system_input(const InputEvent* event);

// ---------------------------------------------------------------- HAL and services the GUI asks about

// The clock: the computer's time of day, until something sets the bar's (POST /api/time/timestamp). Then it runs that
// far apart from the computer's; the GUI's ticks do not jump. The host is told, so that apps see the same time.
//
// The computer's time of day is the clock the ticks go by (host_now) plus what the host gives emu_screen_rtc_follow:
// 0, or less after the computer's clock was set back, which the ticks never follow (packages/server/computer-clock.mjs).
static double emu_rtc_offset_ms;
static double emu_rtc_follow_ms;

double emu_rtc_now(void) {
    return host_now() + emu_rtc_follow_ms + emu_rtc_offset_ms;
}

EMSCRIPTEN_KEEPALIVE void emu_screen_rtc_follow(double ms) {
    emu_rtc_follow_ms = ms;
}

// The bar's clock, Unix ms, as the firmware reads it (for the host's tests).
EMSCRIPTEN_KEEPALIVE double emu_screen_rtc_now(void) {
    return emu_rtc_now();
}

DateTimeMs furi_hal_rtc_get_datetime(void) {
    return datetime_timestamp_ms_to_datetime((time_t)emu_rtc_now());
}

void furi_hal_rtc_set_datetime(const DateTimeMs* datetime) {
    // Whole seconds are set, as the API takes them; a clock set to the computer's own time stays the computer's.
    emu_rtc_offset_ms = (double)datetime_datetime_to_timestamp_ms(datetime) - (host_now() + emu_rtc_follow_ms);
    if(emu_rtc_offset_ms > -2000 && emu_rtc_offset_ms < 2000) emu_rtc_offset_ms = 0;
    char value[32];
    snprintf(value, sizeof(value), "%.0f", emu_rtc_offset_ms);
    host_setting_changed("clock", value);
}

time_t furi_hal_rtc_get_timestamp(void) {
    DateTimeMs datetime = furi_hal_rtc_get_datetime();
    return datetime_datetime_to_timestamp(&datetime.dt);
}

// The display drivers: the frame stays in the GUI's draw buffer, which is what GET /api/screen reads on the bar too.
// The GUI hands them a frame from its refresh (gui.c's flush callbacks); they only note that one came.
static bool emu_front_drawn, emu_back_drawn;
// A refresh that sends a display its frame is where a bar's GUI has spent the time a draw takes (furi_shim.c): once
// a refresh, though LVGL in DIRECT mode flushes every area it redrew (lv_refr.c), as the bar's back display sends one
// frame for them (back_display.c).
static bool emu_display_sent[GuiDisplayIdMax];

void front_display_draw(FrontDisplaySrv* instance, const uint8_t* buf) {
    (void)instance;
    (void)buf;
    emu_front_drawn = true;
    if(!emu_display_sent[GuiDisplayIdFront]) emu_gui_drew(0);
    emu_display_sent[GuiDisplayIdFront] = true;
}

void back_display_draw(BackDisplaySrv* instance, const uint8_t* data) {
    (void)instance;
    (void)data;
    emu_back_drawn = true;
    if(!emu_display_sent[GuiDisplayIdBack]) emu_gui_drew(1);
    emu_display_sent[GuiDisplayIdBack] = true;
}

static void emu_display_refresh_started(lv_event_t* event) {
    emu_display_sent[(GuiDisplayId)(uintptr_t)lv_event_get_user_data(event)] = false;
}

/**
 * Which displays the GUI has drawn a frame on: 1 the front, 2 the back, 3 both. Until its first refresh LVGL has not
 * laid out what the services made while they started, and some of them read sizes from that layout:
 * canvas_screen_open() (canvas.c) sizes its back display by the main layer's root there, which is 0×0 until then, so
 * a drawing from outside sent before it would never show on the back display (EMU-253). On a bar the GUI's thread refreshes from its start, every
 * 16 ms, and the web server answers only once a network link is up, which by the code is far later (not measured on
 * a bar); the host does not answer anybody before both have a frame either (device.mjs).
 */
EMSCRIPTEN_KEEPALIVE int emu_screen_drawn(void) {
    return (emu_front_drawn ? 1 : 0) | (emu_back_drawn ? 2 : 0);
}

size_t back_display_get_width(void) {
    return BACK_DISPLAY_W;
}

size_t back_display_get_height(void) {
    return BACK_DISPLAY_H;
}

// Low power: programs lock it while the bar must stay awake and unlock it when it may sleep (the launcher around a
// running app, for one). The emulator does not sleep by itself.
void low_power_lock(LowPower* instance) {
    (void)instance;
}

void low_power_unlock(LowPower* instance) {
    (void)instance;
}

// The bar asleep in OFF, once the OFF program has played its animation (emu_system.c): both displays are dark. The
// emulator shows that and nothing more (the bar's processor stops, the emulator's programs do not).
static bool emu_asleep;

void emu_screen_sleep(bool asleep) {
    emu_asleep = asleep;
}

// The status lights, the bar's two RGB LEDs beside Start / Pause. On a bar status_lights.c sends each request over the
// intercom to the other processor, whose status_lights_backend.c runs the preset there (presets/*.c: a static color,
// a blink of 500 ms on and 500 ms off, a fade, a rainbow, a notification of three blinks at full brightness and then
// dark) at the brightness the brightness control gives it. Here the host is told what was started, the moment the
// firmware starts it (host_lights), and runs the preset's look itself; the brightness is the host's setting
// (/api/display/brightness, the brightness program), or the override a program holds for the lights while it shows
// something (pairing: full), which is kept here.
static int emu_lights_preset = StatusLightsPresetOff;
static Color emu_lights_color;
static int emu_lights_override = -1; // the user brightness 0..100 a program holds the lights at, -1 none

static void emu_lights_report(bool started) {
    host_lights(emu_lights_preset, emu_lights_color.r, emu_lights_color.g, emu_lights_color.b, emu_lights_override, started);
}

StatusLightsStatus
    status_lights_run_preset(StatusLights* instance, StatusLightsPreset preset, Color color) {
    (void)instance;
    furi_check(preset < StatusLightsPresetsCount);
    emu_lights_preset = preset;
    emu_lights_color = color;
    emu_lights_report(true);
    return StatusLightsStatusOk;
}

// Brightness: the setting the brightness program shows and changes. The emulator's displays do not dim; the host's
// /api/display/brightness follows the setting. (api_display.c's own brightness handler is never routed here.)
static FuriState* emu_brightness;

FuriState* brightness_control_get_state(const BrightnessControl* instance) {
    (void)instance;
    if(!emu_brightness) {
        emu_brightness = furi_state_alloc(sizeof(BrightnessControlState));
        BrightnessControlState state = {.mode = BrightnessControlBrightnessModeAuto, .effective_brightness = 50, .brightness_setting = 50};
        furi_state_set(emu_brightness, &state);
    }
    return emu_brightness;
}

void brightness_control_set_auto_brightness(BrightnessControl* instance) {
    BrightnessControlState state;
    furi_state_get(brightness_control_get_state(instance), &state);
    state.mode = BrightnessControlBrightnessModeAuto;
    furi_state_set(emu_brightness, &state);
    host_setting_changed("brightness", "auto");
}

void brightness_control_set_manual_brightness(BrightnessControl* instance, uint8_t brightness) {
    BrightnessControlState state;
    furi_state_get(brightness_control_get_state(instance), &state);
    state.mode = BrightnessControlBrightnessModeManual;
    state.brightness_setting = state.effective_brightness = brightness;
    furi_state_set(emu_brightness, &state);
    char value[8];
    snprintf(value, sizeof(value), "%u", brightness);
    host_setting_changed("brightness", value);
}

// A program's own brightness for one display while it shows something (the brightness settings' preview), or for
// the status lights (the pairing screens hold them at full brightness while they blink). The displays do not dim in
// the emulator; the lights' override goes to the host.
void brightness_control_set_brightness_override(BrightnessControl* instance, BrightnessControlModule module, uint8_t override) {
    (void)instance;
    if(module != BrightnessControlModuleStatusLights) return;
    emu_lights_override = override > BRIGHTNESS_MAX ? BRIGHTNESS_MAX : override;
    emu_lights_report(false);
}

void brightness_control_reset_brightness_override(BrightnessControl* instance, BrightnessControlModule module) {
    (void)instance;
    if(module != BrightnessControlModuleStatusLights) return;
    emu_lights_override = -1;
    emu_lights_report(false);
}

void front_display_sleep_mode(FrontDisplaySrv* instance, bool sleep) {
    (void)instance;
    (void)sleep;
}

// ---------------------------------------------------------------- the web server around the firmware's API handlers

// web_server.c's dispatch (http_handler_add, http_handle_request and the two replies it makes itself), as in the
// firmware: the first handler whose uri the path starts with gets the rest of the path; a method it does not take is
// answered 405 with the methods it does.
static const struct {
    const char* name;
    HttpMethod method;
} emu_http_methods[] = {
    {"GET", HttpMethodGet},
    {"POST", HttpMethodPost},
    {"DELETE", HttpMethodDelete},
    {"PUT", HttpMethodPut},
    {"OPTIONS", HttpMethodOptions},
    {"HEAD", HttpMethodHead},
    {"CONNECT", HttpMethodConnect},
    {"PATCH", HttpMethodPatch},
    {"TRACE", HttpMethodTrace},
};

#define EMU_HTTP_API_METHODS ((HttpMethod)(HttpMethodGet | HttpMethodPost | HttpMethodPut | HttpMethodDelete))

static void emu_http_cat_methods(FuriString* headers, HttpMethod allowed_methods) {
    if(allowed_methods & HttpMethodWebSocket) {
        allowed_methods = (HttpMethod)((allowed_methods & ~HttpMethodWebSocket) | HttpMethodGet);
    }
    allowed_methods = (HttpMethod)(allowed_methods & EMU_HTTP_API_METHODS);
    bool is_first = true;
    for(size_t i = 0; i < COUNT_OF(emu_http_methods); i++) {
        if(allowed_methods & emu_http_methods[i].method) {
            furi_string_cat_printf(headers, "%s%s", is_first ? "" : ", ", emu_http_methods[i].name);
            is_first = false;
        }
    }
    furi_string_cat(headers, "\r\n");
}

void http_reply_405_method_not_allowed(struct mg_connection* conn, HttpMethod allowed_methods, bool close) {
    FuriString* headers = furi_string_alloc_set(DEFAULT_JSON_HEADERS);
    furi_string_cat(headers, "Allow: ");
    emu_http_cat_methods(headers, allowed_methods);
    if(close) furi_string_cat(headers, "Connection: close\r\n");
    MG_REPLY_METHOD_NOT_ALLOWED(conn, furi_string_get_cstr(headers));
    furi_string_free(headers);
}

void http_reply_cors_preflight(struct mg_connection* conn, HttpMethod allowed_methods) {
    FuriString* headers = furi_string_alloc_set(HEADER_CORS_ORIGIN HEADER_CORS_HEADERS "Access-Control-Allow-Methods: ");
    emu_http_cat_methods(headers, allowed_methods);
    MG_REPLY_CORS_OPTIONS(conn, furi_string_get_cstr(headers));
    furi_string_free(headers);
}

void http_handler_add(HttpHandlersList_t list, const HttpHandler* handler) {
    HttpHandlerInstance inst = {.handler = handler, .context = NULL};
    if(handler->type == HttpHandlerCustom && handler->ctx_alloc) inst.context = handler->ctx_alloc();
    HttpHandlersList_push_back(list, inst);
}

bool http_handle_request(
    FuriString* path,
    HttpMethod method,
    HttpHandlersList_t handlers,
    struct mg_connection* conn,
    struct mg_http_message* msg) {
    HttpHandlersList_it_t it;
    for(HttpHandlersList_it(it, handlers); !HttpHandlersList_end_p(it); HttpHandlersList_next(it)) {
        const HttpHandlerInstance* inst = HttpHandlersList_cref(it);
        if(!furi_string_start_with(path, inst->handler->uri)) continue;
        if(method == HttpMethodUnknown) {
            http_reply_405_method_not_allowed(conn, inst->handler->method, false);
            return true;
        }
        if(!(method & inst->handler->method)) {
            if(method == HttpMethodOptions) {
                http_reply_cors_preflight(conn, inst->handler->method);
            } else {
                http_reply_405_method_not_allowed(conn, inst->handler->method, false);
            }
            return true;
        }
        FuriString* path_remain = furi_string_alloc_set(path);
        furi_string_right(path_remain, strlen(inst->handler->uri));
        if(furi_string_start_with(path_remain, "/")) furi_string_right(path_remain, 1);
        bool handled = inst->handler->on_request(path_remain, method, conn, msg, inst->context);
        furi_string_free(path_remain);
        if(handled) return true;
    }
    return false;
}

// The handlers of the firmware's API root (api_root.c) that are in the emulator, in the order the firmware tries
// them. The rest of the API is the host's (packages/server/device.mjs).
static const HttpHandler emu_api_handlers[] = {
    {.uri = "smart_home", .method = HttpMethodAny, .type = HttpHandlerCustom, .ctx_alloc = http_api_smart_home_alloc, .on_request = http_api_smart_home_callback},
    {.uri = "busy", .method = HttpMethodAny, .type = HttpHandlerCustom, .ctx_alloc = http_api_busy_alloc, .on_request = http_api_busy_callback},
    {.uri = "account", .method = HttpMethodAny, .type = HttpHandlerCustom, .ctx_alloc = http_api_account_alloc, .on_request = http_api_account_callback},
    {.uri = "name", .method = HttpMethodGet | HttpMethodPost, .type = HttpHandlerCustom, .on_request = http_api_name_callback},
    {.uri = "time", .method = HttpMethodAny, .type = HttpHandlerCustom, .ctx_alloc = http_api_time_alloc, .on_request = http_api_time_callback},
    {.uri = "ble", .method = HttpMethodAny, .type = HttpHandlerCustom, .ctx_alloc = http_api_ble_alloc, .on_request = http_api_ble_callback},
    {.uri = "update", .method = HttpMethodAny, .type = HttpHandlerCustom, .ctx_alloc = http_api_update_alloc, .on_request = http_api_update_callback},
    {.uri = "wifi", .method = HttpMethodAny, .type = HttpHandlerCustom, .ctx_alloc = http_api_wifi_alloc, .on_request = http_api_wifi_callback},
    {.uri = "display", .method = HttpMethodAny, .type = HttpHandlerCustom, .ctx_alloc = http_api_display_alloc, .on_request = http_api_display_callback},
};
static HttpHandlersList_t emu_api;

#define EMU_MAX_CONNECTIONS (16)

static struct mg_mgr emu_mgr;
static struct mg_connection* emu_connections[EMU_MAX_CONNECTIONS];
static unsigned long emu_next_connection_id = 1;
static bool emu_announced[EMU_MAX_CONNECTIONS];

struct mg_mgr* web_srv_get_mgr(void) {
    return &emu_mgr;
}

static struct mg_connection* emu_connection(unsigned long id) {
    for(int i = 0; i < EMU_MAX_CONNECTIONS; i++) {
        if(emu_connections[i] && emu_connections[i]->id == id) return emu_connections[i];
    }
    return NULL;
}

// A reply written after the request returned (a draw that waited in canvas, a timer of the web server) is told to the
// host once.
static void emu_announce_replies(void) {
    for(int i = 0; i < EMU_MAX_CONNECTIONS; i++) {
        struct mg_connection* conn = emu_connections[i];
        if(!conn || !conn->send.len || emu_announced[i]) continue;
        emu_announced[i] = true;
        host_reply_ready(conn->id);
    }
}

// What canvas's draw callback calls (as mg_wakeup) to answer the request from the web server's thread.
bool emu_mg_wakeup(struct mg_mgr* mgr, unsigned long id, const void* buf, size_t len) {
    (void)mgr;
    struct mg_connection* conn = emu_connection(id);
    if(!conn) return false;
    ConnectionContext* ctx = (void*)conn->data;
    if(ctx->on_wakeup) ctx->on_wakeup(conn, (void*)buf, len);
    emu_announce_replies();
    return true;
}

// The web server's own timers (the wait for an account pairing code), polled on the GUI's tick.
void emu_web_server_poll(void) {
    if(!emu_mgr.timers) return;
    // The host's clock: mongoose's own reads a clock Emscripten does not have and stands still.
    mg_timer_poll(&emu_mgr.timers, (uint64_t)host_now());
    emu_announce_replies();
}

/**
 * An API request for one of the firmware's handlers above; `path` is what follows /api/, as "display/draw". Returns
 * the connection id; the reply is ready when emu_screen_reply_size() is non-zero, now or after host_reply_ready(id).
 * The host frees it with emu_screen_release().
 */
EMSCRIPTEN_KEEPALIVE unsigned long emu_screen_request(
    const char* method,
    const char* path,
    const char* query,
    const char* body,
    size_t body_size) {
    int slot = 0;
    while(slot < EMU_MAX_CONNECTIONS && emu_connections[slot]) slot++;
    if(slot == EMU_MAX_CONNECTIONS) return 0;

    struct mg_connection* conn = calloc(1, sizeof(struct mg_connection));
    conn->id = emu_next_connection_id++;
    conn->mgr = &emu_mgr;
    emu_connections[slot] = conn;
    emu_announced[slot] = false;

    struct mg_http_message msg = {0};
    msg.method = mg_str(method);
    msg.uri = mg_str(path);
    msg.query = mg_str(query);
    msg.body = mg_str_n(body, body_size);

    HttpMethod http_method = HttpMethodUnknown;
    for(size_t i = 0; i < COUNT_OF(emu_http_methods); i++) {
        if(strcmp(method, emu_http_methods[i].name) == 0) http_method = emu_http_methods[i].method;
    }
    FuriString* route = furi_string_alloc_set_str(path);
    if(!http_handle_request(route, http_method, emu_api, conn, &msg)) MG_REPLY_BAD_REQUEST(conn);
    furi_string_free(route);
    // The services handle what the request posted to them before the host looks for the reply.
    emu_pump();
    // A reply that is already here is read by the host at once and is not announced.
    if(conn->send.len) emu_announced[slot] = true;
    return conn->id;
}

EMSCRIPTEN_KEEPALIVE const char* emu_screen_reply(unsigned long id) {
    struct mg_connection* conn = emu_connection(id);
    return conn ? (const char*)conn->send.buf : NULL;
}

EMSCRIPTEN_KEEPALIVE size_t emu_screen_reply_size(unsigned long id) {
    struct mg_connection* conn = emu_connection(id);
    return conn ? conn->send.len : 0;
}

EMSCRIPTEN_KEEPALIVE void emu_screen_release(unsigned long id) {
    for(int i = 0; i < EMU_MAX_CONNECTIONS; i++) {
        struct mg_connection* conn = emu_connections[i];
        if(!conn || conn->id != id) continue;
        // A draw still waiting in canvas forgets the connection, as when an HTTP client goes away.
        ConnectionContext* ctx = (void*)conn->data;
        if(ctx->on_close) ctx->on_close(conn);
        mg_iobuf_free(&conn->send);
        free(conn);
        emu_connections[i] = NULL;
    }
}

// ---------------------------------------------------------------- what a sleep lets the GUI do

// On a bar the GUI's thread goes on drawing while another thread sleeps, and some code sleeps for exactly that: the
// BUSY program, before it takes a picture of the screen for its pause overlay, "for the Gui to redraw the
// background". So a sleep here ends with both displays drawn as they stand: what has changed since the last tick is
// rendered, and nothing else moves (animations step with the clock, on the tick). Not when it is the GUI's own
// thread that sleeps, in the middle of LVGL.
static void emu_screen_draw_in_sleep(void) {
    Gui* gui = furi_record_open(RECORD_GUI);
    furi_record_close(RECORD_GUI);
    if(emu_loop_in_callback(gui->event_loop)) return;
    for(lv_display_t* display = lv_display_get_next(NULL); display; display = lv_display_get_next(display)) {
        lv_timer_t* timer = lv_display_get_refr_timer(display);
        if(timer) lv_display_refr_timer(timer);
    }
}

// ---------------------------------------------------------------- frames, input, loader

/**
 * Copies a display's frame into `out` as GET /api/screen?display= sends it (before base64): the front display's
 * RGB888 buffer (bytes B, G, R), the back display's 8-bit gray packed to 4 bits. Returns the size. In OFF the panels
 * sleep but the buffers stay: a bar goes on answering with them (the status bar on the back, black on the front).
 */
EMSCRIPTEN_KEEPALIVE size_t emu_screen_frame(int display, uint8_t* out) {
    Gui* gui = furi_record_open(RECORD_GUI);
    const uint8_t* buf = gui_display_get_frame_buffer(gui, display ? GuiDisplayIdBack : GuiDisplayIdFront);
    furi_record_close(RECORD_GUI);
    if(display == 0) {
        memcpy(out, buf, FRONT_DISPLAY_BUF_SIZE);
        return FRONT_DISPLAY_BUF_SIZE;
    }
    color_buf_l8_to_l4(out, buf, BACK_DISPLAY_BUF_SIZE);
    return BACK_DISPLAY_BUF_SIZE / 2;
}

/** Whether the panels sleep (OFF): what a person sees is dark, whatever the buffers hold. */
EMSCRIPTEN_KEEPALIVE int emu_screen_asleep(void) {
    return emu_asleep;
}

/**
 * Starts each of LVGL's timers again from now: its next run is a period from here. The server does it when its clock
 * is held (screen.mjs), so that what the GUI does after a hold does not depend on when its timers last ran: the
 * display's refresh, every 16 ms, runs on every other tick, and which ones the history of the clock decides.
 */
EMSCRIPTEN_KEEPALIVE void emu_screen_restart_timers(void) {
    for(lv_timer_t* timer = lv_timer_get_next(NULL); timer; timer = lv_timer_get_next(timer)) lv_timer_reset(timer);
}

/**
 * Whether the GUI's drawing still goes on, when drawing takes it time (bar speed, furi_shim.c): it runs past the next
 * tick, or a display has something left to draw (its refresh timer runs until it has drawn it, and the draw will take
 * time when it comes). A hold stops the clock only once it does not (screen.mjs): what the GUI draws after a stop, and
 * when, must not depend on what was drawn before it.
 */
EMSCRIPTEN_KEEPALIVE int emu_screen_drawing(void) {
    if(!emu_gui_draws_take_time()) return 0;
    if(emu_gui_behind()) return 1;
    for(lv_display_t* display = lv_display_get_next(NULL); display; display = lv_display_get_next(display)) {
        lv_timer_t* timer = lv_display_get_refr_timer(display);
        if(timer && !lv_timer_get_paused(timer)) return 1;
    }
    return 0;
}

/**
 * How many of LVGL's timers run, other than the displays' refreshes: an animation of the firmware's own (an animation
 * player, LVGL's animations) is under way while it is more than when the GUI stands still.
 */
EMSCRIPTEN_KEEPALIVE int emu_screen_running_timers(void) {
    int running = 0;
    for(lv_timer_t* timer = lv_timer_get_next(NULL); timer; timer = lv_timer_get_next(timer)) {
        if(lv_timer_get_paused(timer)) continue;
        bool refresh = false;
        for(lv_display_t* display = lv_display_get_next(NULL); display; display = lv_display_get_next(display))
            if(lv_display_get_refr_timer(display) == timer) refresh = true;
        if(!refresh) running++;
    }
    return running;
}

/**
 * A key event as the input service publishes it; key and type are the firmware's InputKey and InputType. As in
 * input.c, every event of one press (press, short or long, repeat, release) carries the press's sequence number: the
 * JS app launcher matches a short Back to its press by it.
 */
EMSCRIPTEN_KEEPALIVE void emu_screen_input(int key, int type) {
    static uint32_t sequence = 0;
    static uint32_t key_sequence[InputKeyMAX];
    if(key < 0 || key >= InputKeyMAX) return;
    if(type == InputTypePress) key_sequence[key] = ++sequence;
    InputEvent event = {
        .key = key,
        .type = type,
        .sequence_source = INPUT_SEQUENCE_SOURCE_HARDWARE,
        .sequence_number = key_sequence[key],
    };
    emu_system_input(&event);
    FuriPubSub* input = furi_record_open(RECORD_INPUT_EVENTS);
    furi_pubsub_publish(input, &event);
    furi_record_close(RECORD_INPUT_EVENTS);
    emu_pump();
}

EMSCRIPTEN_KEEPALIVE void emu_screen_init(void) {
    emu_system_init();
    furi_record_create(RECORD_INPUT_EVENTS, furi_pubsub_alloc());

    font_registry_startup(NULL);
    gui_srv(NULL);
    Gui* gui = furi_record_open(RECORD_GUI);
    emu_gui_set_loop(gui->event_loop);
    for(GuiDisplayId d = 0; d < GuiDisplayIdMax; d++)
        lv_display_add_event_cb(gui->displays[d].lv_display, emu_display_refresh_started, LV_EVENT_REFR_START, (void*)(uintptr_t)d);
    furi_record_close(RECORD_GUI);
    emu_sleep_hook = emu_screen_draw_in_sleep;
    emu_status_init();
    status_bar_srv(NULL);
    canvas_service_start(NULL);
    emu_pump();
    emu_system_start();
    // The firmware's supervisor: its warnings over everything else (battery critical, a fatal JS error), and the
    // restart or power-off that follows them.
    supervisor_start(NULL);
    HttpHandlersList_init(emu_api);
    for(size_t i = 0; i < COUNT_OF(emu_api_handlers); i++) http_handler_add(emu_api, &emu_api_handlers[i]);
}
