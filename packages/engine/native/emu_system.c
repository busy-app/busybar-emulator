// The system around the apps, for the screen module: the firmware's desktop, apps menu and JS app launcher run
// unchanged on top of this.
//
//   - Loader: starts one app at a time by name, as loader.c does (priority, BeforeLoad / PriorityChanged /
//     ApplicationStopped events, FuriSignalExit to stop). Apps' main functions return at once here; an app is running
//     while its event loop is (furi_shim.c, emu_event_loop_run_then).
//   - Input: the mode selector's position, the FuriState the desktop follows (input.c updates it on a switch press).
//   - js_runner: the JS app launcher's runner. The app itself runs in the runtime module, so starting and aborting go
//     to the host, which reports back through emu_screen_script_event().
//   - BUSY and CUSTOM are the firmware's "busy" program on the firmware's BUSY timer service (emu_modes.c has what
//     they reach for outside the GUI); OFF is soft_off.c rewritten for one thread; SETTINGS is the firmware's settings
//     menu with the settings programs it lists (emu_settings.c). The boot animation ("Power On", which the desktop
//     waits out before starting the selector's app) is a blank screen.
#include <furi.h>

#include <applications.h>
#include <apps_menu/apps_menu.h>
#include <desktop/desktop.h>
#include <desktop/desktop_i.h>
#include <furi_hal_nvm.h>
#include <gui/gui.h>
#include <gui/modules/anim_player.h>
#include <gui/modules/label.h>
#include <low_power/low_power.h>
#include <soft_off/storage_macros.h>
#include <input/input.h>
#include <js_app_launcher/js_app_launcher.h>
#include <js_app_launcher/js_app_launcher_i.h>
#include <js_runner/js_runner.h>
#include <font_registry/fonts.h>
#include <loader/loader.h>
#include <toolbox/semver.h>
#include <web_server/http_api/http_api.h>

#include <emscripten.h>
#include <string.h>

#include "host.h"
#include "shim.h"

#define TAG "EmuSystem"

int32_t apps_menu_app(void* arg);
void apps_menu_on_system_start(void);
int32_t js_app_launcher_app(void* arg);
int32_t desktop_srv(void* arg);
int32_t busy_app(void* arg);
int32_t settings_app(void* arg);
void emu_screen_sleep(bool asleep);
int busy_timer_srv(void* arg);

// The address the emulated bar answers on, for the APPS screen with no apps (host.h, patches.mjs).
EM_JS(char*, host_bar_address, (void), {
    const address = Module.host.barAddress ? Module.host.barAddress() : null;
    return address ? stringToNewUTF8(address) : 0;
});

// ---------------------------------------------------------------- input: the mode selector

struct Input {
    FuriState* switch_pos;
};

static struct Input emu_input;

FuriState* input_get_switch_pos(Input* input) {
    return input->switch_pos;
}

// ---------------------------------------------------------------- apps the emulator has no screen for

typedef struct {
    FuriEventLoop* event_loop;
    Gui* gui;
    Label* front;
    Label* back;
} EmuPlaceholderApp;

static bool emu_placeholder_signal(uint32_t signal, void* arg, void* context) {
    UNUSED(arg);
    EmuPlaceholderApp* app = context;
    if(signal == FuriSignalExit) furi_event_loop_stop(app->event_loop);
    return signal == FuriSignalExit || signal == FuriSignalAboutToExit;
}

static void emu_placeholder_free(void* context) {
    EmuPlaceholderApp* app = context;
    furi_thread_set_signal_callback(furi_thread_get_current(), NULL, NULL);
    with_gui(app->gui, {
        label_free(app->front);
        label_free(app->back);
    });
    furi_record_close(RECORD_GUI);
    furi_event_loop_free(app->event_loop);
    free(app);
}

static int32_t emu_placeholder_app(void* arg) {
    UNUSED(arg);
    static const char* const modes[] = {
        [InputSwitchPositionBusy] = "BUSY",
        [InputSwitchPositionStatus] = "CUSTOM",
        [InputSwitchPositionOff] = "OFF",
        [InputSwitchPositionApps] = "APPS",
        [InputSwitchPositionSettings] = "SETTINGS",
    };
    InputSwitchPosition position;
    furi_state_get(emu_input.switch_pos, &position);
    const char* mode = position < InputSwitchPositionMAX ? modes[position] : "?";

    EmuPlaceholderApp* app = malloc(sizeof(EmuPlaceholderApp));
    app->event_loop = furi_event_loop_alloc();
    app->gui = furi_record_open(RECORD_GUI);
    const bool boot = strcmp(furi_thread_get_name(furi_thread_get_current_id()), DESKTOP_STARTUP_APP_NAME) == 0;
    if(boot) mode = "";
    with_gui(app->gui, {
        GuiLayer* layer = gui_get_layer(app->gui, GuiLayerIdMain);
        app->front = label_alloc(gui_layer_get_root_widget(layer, GuiDisplayIdFront));
        label_set_font(app->front, FONT_BUSY_REGULAR_7);
        label_set_text(app->front, mode);
        widget_set_align(label_get_base(app->front), AlignCenter);
        app->back = label_alloc(gui_layer_get_root_widget(layer, GuiDisplayIdBack));
        char text[64] = "";
        if(!boot) snprintf(text, sizeof(text), "%s mode is not\nin the emulator.\nApps live in APPS.", mode);
        label_set_text(app->back, text);
        widget_set_align(label_get_base(app->back), AlignCenter);
    });
    furi_thread_set_signal_callback(furi_thread_get_current(), emu_placeholder_signal, app);
    emu_event_loop_run_then(app->event_loop, emu_placeholder_free, app);
    return 0;
}

// ---------------------------------------------------------------- OFF: soft_off.c on an event loop

// applications/main/soft_off/soft_off.c waits on its thread's flags, which a single thread cannot do. This is the same
// program on an event loop: the turn-off animation on the front display, then the bar is allowed to sleep; leaving
// OFF wakes it.
typedef struct {
    FuriEventLoop* event_loop;
    Gui* gui;
    LowPower* low_power;
    AnimPlayer* anim_player;
    bool is_low_power_requested;
} EmuSoftOffApp;

static bool emu_soft_off_signal(uint32_t signal, void* arg, void* context) {
    UNUSED(arg);
    EmuSoftOffApp* app = context;
    if(signal != FuriSignalExit) return false;
    furi_event_loop_stop(app->event_loop);
    return true;
}

static void emu_soft_off_animation_finished(AnimPlayer* anim_player, const AnimFileFrameInfo* frame, void* context) {
    UNUSED(anim_player);
    EmuSoftOffApp* app = context;
    if(frame->flags & AnimFileFrameFlagError) return;
    if(!(frame->flags & AnimFileFrameFlagFinished)) return;
    low_power_unlock(app->low_power);
    app->is_low_power_requested = true;
    emu_screen_sleep(true);
}

static void emu_soft_off_free(void* context) {
    EmuSoftOffApp* app = context;
    furi_thread_set_signal_callback(furi_thread_get_current(), NULL, NULL);
    with_gui(app->gui, { anim_player_free(app->anim_player); });
    if(app->is_low_power_requested) low_power_lock(app->low_power);
    emu_screen_sleep(false);
    furi_record_close(RECORD_GUI);
    furi_record_close(RECORD_LOW_POWER);
    furi_event_loop_free(app->event_loop);
    free(app);
}

static int32_t emu_soft_off_app(void* arg) {
    UNUSED(arg);
    Loader* loader = furi_record_open(RECORD_LOADER);
    loader_set_priority(loader, 0);
    furi_record_close(RECORD_LOADER);

    EmuSoftOffApp* app = malloc(sizeof(EmuSoftOffApp));
    app->event_loop = furi_event_loop_alloc();
    app->gui = furi_record_open(RECORD_GUI);
    app->low_power = furi_record_open(RECORD_LOW_POWER);
    app->is_low_power_requested = false;
    furi_thread_set_signal_callback(furi_thread_get_current(), emu_soft_off_signal, app);
    with_gui(app->gui, {
        GuiLayer* layer = gui_get_layer(app->gui, GuiLayerIdMain);
        Widget* root = gui_layer_get_root_widget(layer, GuiDisplayIdFront);
        app->anim_player = anim_player_alloc(root);
        anim_player_set_source(app->anim_player, SOFT_OFF_ANIM_PATH("turn_off_72x16.anim"));
        anim_player_set_frame_callback(app->anim_player, emu_soft_off_animation_finished, app);
        anim_player_set_section(app->anim_player, AnimFilePlayFlagNone, ANIM_FILE_DEFAULT_SECTION);
    });
    emu_event_loop_run_then(app->event_loop, emu_soft_off_free, app);
    return 0;
}

// ---------------------------------------------------------------- loader

typedef struct {
    const char* name;
    FuriThreadCallback entry;
} EmuApp;

static const EmuApp emu_apps[] = {
    {"apps_menu", apps_menu_app},
    {JS_APP_LAUNCHER_APP_ID, js_app_launcher_app},
    {"busy", busy_app},
    {"soft_off", emu_soft_off_app},
    {"settings_menu", settings_app},
    {DESKTOP_STARTUP_APP_NAME, emu_placeholder_app},
};

struct Loader {
    FuriPubSub* pubsub;
    size_t priority;
    FuriThread* thread;
    char* name;
    char* args;
};

static struct Loader emu_loader;

static void emu_loader_publish(LoaderEventType type, size_t priority) {
    LoaderEvent event = {.type = type, .priority = priority};
    furi_pubsub_publish(emu_loader.pubsub, &event);
}

// The app's thread is over: loader_app_closed_handler.
static void emu_loader_app_closed(FuriThread* thread) {
    if(!thread || thread != emu_loader.thread) return;
    furi_thread_free(emu_loader.thread);
    free(emu_loader.name);
    free(emu_loader.args);
    emu_loader.thread = NULL;
    emu_loader.name = emu_loader.args = NULL;
    emu_loader.priority = 0;
    emu_loader_publish(LoaderEventTypePriorityChanged, 0);
    emu_loader_publish(LoaderEventTypeApplicationStopped, 0);
}

LoaderStatus loader_start(Loader* instance, const char* name, const char* args, FuriString* error_message) {
    UNUSED(instance);
    if(emu_loader.thread) {
        if(error_message) furi_string_printf(error_message, "Loader is locked, please close the \"%s\" first", emu_loader.name);
        return LoaderStatusErrorAppStarted;
    }
    FuriThreadCallback entry = NULL;
    for(size_t i = 0; i < COUNT_OF(emu_apps); i++) {
        if(strcmp(emu_apps[i].name, name) == 0) entry = emu_apps[i].entry;
    }
    // A settings program, by its name or its id, as loader.c finds them.
    for(size_t i = 0; i < FLIPPER_SETTINGS_APPS_COUNT; i++) {
        const FlipperInternalApplication* settings = &FLIPPER_SETTINGS_APPS[i];
        if(strcmp(settings->name, name) == 0 || strcmp(settings->appid, name) == 0) entry = settings->app;
    }
    if(!entry) {
        if(error_message) furi_string_printf(error_message, "Application \"%s\" not found", name);
        return LoaderStatusErrorUnknownApp;
    }

    FURI_LOG_I(TAG, "Starting %s", name);
    emu_loader_publish(LoaderEventTypeApplicationBeforeLoad, 0);
    emu_loader.name = strdup(name);
    emu_loader.args = (args && strlen(args) > 0) ? strdup(args) : NULL;
    emu_loader.thread = furi_thread_alloc_ex(name, 0, entry, emu_loader.args);
    emu_loader.priority = LOADER_DEFAULT_APP_PRIORITY;
    emu_loader_publish(LoaderEventTypePriorityChanged, emu_loader.priority);

    FuriThread* thread = emu_loader.thread;
    furi_thread_start(thread);
    // An app that did not keep a loop running is already over (apps menu resuming the last app, for one).
    if(!emu_thread_is_running(thread)) emu_loader_app_closed(thread);
    return LoaderStatusOk;
}

LoaderStatus loader_stop(Loader* instance) {
    UNUSED(instance);
    if(!emu_loader.thread) return LoaderStatusErrorAppNotRunning;
    if(!furi_thread_signal(emu_loader.thread, FuriSignalExit, NULL)) return LoaderStatusErrorNoSignalHandler;
    return LoaderStatusOk;
}

bool loader_send_signal(Loader* instance, uint32_t signal, void* arg) {
    UNUSED(instance);
    return emu_loader.thread ? furi_thread_signal(emu_loader.thread, signal, arg) : false;
}

bool loader_get_application_name(Loader* instance, FuriString* name) {
    UNUSED(instance);
    if(!emu_loader.thread) return false;
    furi_string_set(name, emu_loader.name);
    return true;
}

bool loader_is_locked(Loader* instance) {
    UNUSED(instance);
    return emu_loader.thread != NULL;
}

FuriPubSub* loader_get_pubsub(Loader* instance) {
    return instance->pubsub;
}

size_t loader_get_priority(Loader* instance) {
    return instance->priority;
}

bool loader_set_priority(Loader* instance, size_t priority) {
    if(!instance->thread) return false;
    instance->priority = priority;
    emu_loader_publish(LoaderEventTypePriorityChanged, priority);
    return true;
}

// /data/... for the app the loader runs (the apps menu keeps its settings there).
static const char* emu_loader_app_name(void) {
    return emu_loader.name;
}

// ---------------------------------------------------------------- js_runner: the app runs in the runtime module

struct JsRunnerContextHandle {
    char* app_id;
    size_t heap_size;
};

struct JsRunnerExecutionHandle {
    uint32_t id; // the host reports on a run by this number
    JsRunnerEventCallback callback;
    void* context;
    bool aborted;
};

static uint32_t emu_last_execution_id;

// The app running now; one at a time, like the bar's JS runner.
static JsRunnerExecutionHandle* emu_execution;

JsRunnerContextInitResult js_runner_context_alloc(
    JsRunner* instance,
    const char* app_id,
    size_t heap_size,
    JsRunnerConsoleOutCallback console_write_cb,
    void* console_write_context) {
    UNUSED(instance);
    // The app's console goes to the emulator's console by the host, not through the launcher's log.
    UNUSED(console_write_cb);
    UNUSED(console_write_context);
    JsRunnerContextHandle* handle = malloc(sizeof(JsRunnerContextHandle));
    handle->app_id = strdup(app_id);
    handle->heap_size = heap_size;
    return (JsRunnerContextInitResult){.error = JsRunnerErrorNone, .handle = handle};
}

void js_runner_context_free(JsRunnerContextHandle* handle) {
    free(handle->app_id);
    free(handle);
}

JsRunnerRunResult js_runner_run(
    JsRunnerContextHandle* handle,
    const char* path,
    JsRunnerEventCallback event_callback,
    void* context) {
    FURI_LOG_D(TAG, "Run %s%s", path, emu_execution ? ": another app is running" : "");
    if(emu_execution) return (JsRunnerRunResult){.error = JsRunnerErrorResource, .handle = NULL};
    JsRunnerExecutionHandle* execution = malloc(sizeof(JsRunnerExecutionHandle));
    execution->callback = event_callback;
    execution->context = context;
    execution->aborted = false;
    execution->id = ++emu_last_execution_id;
    emu_execution = execution;
    host_app_start(execution->id, handle->app_id, path, handle->heap_size);
    return (JsRunnerRunResult){.error = JsRunnerErrorNone, .handle = execution};
}

void js_runner_abort(JsRunnerExecutionHandle* handle) {
    FURI_LOG_D(TAG, "Abort%s", handle->aborted ? " (again)" : "");
    if(handle->aborted) return;
    handle->aborted = true;
    if(handle == emu_execution) host_app_abort();
}

JsRunnerError js_runner_join(JsRunnerExecutionHandle* handle, uint32_t timeout) {
    UNUSED(timeout);
    if(handle == emu_execution) emu_execution = NULL;
    free(handle);
    return JsRunnerErrorNone;
}

// A fatal error of the JS engine (js_runner.c's js_runner_handle_fatal_error): the engine cannot go on, the app's
// thread never returns, and the supervisor is told. It shows its warning in the first 30 seconds after start or on a
// bar with the debug flag, and restarts the bar otherwise.
static FuriPubSub* emu_js_fatal_pubsub;

FuriPubSub* js_runner_get_fatal_pubsub(JsRunner* instance) {
    UNUSED(instance);
    if(!emu_js_fatal_pubsub) emu_js_fatal_pubsub = furi_pubsub_alloc();
    return emu_js_fatal_pubsub;
}

/** The app's engine ran into a fatal error in the runtime module: out of memory, or anything else. */
EMSCRIPTEN_KEEPALIVE void emu_screen_js_fatal(int out_of_memory) {
    JsRunnerFatal error = out_of_memory ? JsRunnerFatalOutOfMemory : JsRunnerFatalGeneric;
    furi_pubsub_publish(js_runner_get_fatal_pubsub(NULL), &error);
    emu_pump();
}

const char* js_runner_get_error_message(JsRunnerError error) {
    static const char* const error_messages[] = {
        [JsRunnerErrorNone] = "OK",
        [JsRunnerErrorUnknown] = "Unknown error",
        [JsRunnerErrorFilesystem] = "Failed to read script file",
        [JsRunnerErrorOutOfMemory] = "Out of memory",
        [JsRunnerErrorParseException] = "Parse exception",
        [JsRunnerErrorInvalidAppId] = "Invalid App ID",
        [JsRunnerErrorResource] = "Out of resources",
        [JsRunnerErrorTimeout] = "Timeout",
    };
    return error < JsRunnerErrorMax ? error_messages[error] : "Unknown error";
}

/**
 * The host reports on the app it started as run `id`: JsRunnerEventTypeScriptStarted once main.js has parsed, or
 * JsRunnerEventTypeScriptFinished with the error, as js_runner.c notifies the launcher. Reports on a run that has been
 * aborted or replaced are dropped.
 */
EMSCRIPTEN_KEEPALIVE void emu_screen_script_event(uint32_t id, int type, int error) {
    JsRunnerExecutionHandle* execution = emu_execution;
    if(!execution || execution->aborted || execution->id != id) return;
    const JsRunnerEvent event = {.type = type, .error = error};
    execution->callback(&event, execution->context);
    emu_pump();
}

// ---------------------------------------------------------------- the HTTP API's way into the launcher

/** POST /api/apps/launch: api_apps.c starts the app in "resume" mode. Returns a JsAppLauncherStatus. */
EMSCRIPTEN_KEEPALIVE int emu_screen_launch(const char* app_id) {
    JsAppLauncherStatus status = js_app_launcher_start(app_id, JsAppLauncherStartModeResume);
    emu_pump();
    return status;
}

/** POST /api/apps/quit: the app exits and the apps menu forgets it. Returns a JsAppLauncherStatus. */
EMSCRIPTEN_KEEPALIVE int emu_screen_quit(void) {
    JsAppLauncherStatus status = js_app_launcher_stop(JsAppLauncherStopModeForget);
    emu_pump();
    return status;
}

// ---------------------------------------------------------------- odds and ends the system asks about

bool web_server_is_api_version_compatible(const SemVer* version) {
    static const SemVer api_version = API_VERSION;
    return semver_compare(version, &api_version) != SemVerOrderingNewer;
}

// A bar as owners have it, no NVM flags set: apps marked "debug" in their manifest are not in the apps menu (they still
// run through the API), as on the bar the golden frames were recorded on.
bool furi_hal_nvm_is_flag_set(FuriHalNvmFlag flag) {
    UNUSED(flag);
    return false;
}

void furi_hal_nvm_reset(void) {
}

// ---------------------------------------------------------------- start

void emu_system_init(void) {
    emu_loader.pubsub = furi_pubsub_alloc();
    furi_record_create(RECORD_LOADER, &emu_loader);
    emu_input.switch_pos = furi_state_alloc(sizeof(InputSwitchPosition));
    InputSwitchPosition unknown = InputSwitchPositionMAX;
    furi_state_set(emu_input.switch_pos, &unknown);
    furi_record_create(RECORD_INPUT, &emu_input);
    emu_thread_exit_hook = emu_loader_app_closed;
    emu_app_data_owner = emu_loader_app_name;
}

void emu_system_start(void) {
    // The BUSY timer, which the BUSY and CUSTOM programs show and /api/busy sets.
    busy_timer_srv(NULL);
    apps_menu_on_system_start();
    desktop_srv(NULL);
    // The selector is in APPS: the desktop starts the apps menu.
    InputSwitchPosition apps = InputSwitchPositionApps;
    furi_state_set(emu_input.switch_pos, &apps);
    emu_pump();
}

/** The input service's switch state: a press of a selector key moves it (input_update_absolute_state). */
void emu_system_input(const InputEvent* event) {
    if(event->type == InputTypePress && event->key >= InputKeyBusy && event->key <= InputKeySettings) {
        InputSwitchPosition position = event->key - InputKeyBusy;
        furi_state_set(emu_input.switch_pos, &position);
    }
}
