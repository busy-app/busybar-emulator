// The emulator's replacement for js_runner.c: one app, one thread, driven by the host.
//
// The globals (console, timers, input, URL, Headers, Request, Response, fetch, localStorage, stubs) come from the
// firmware's own applications/services/js_runner/*.c, compiled unchanged. This file provides what js_runner.c gives
// them: the app state, the job loop, the lifecycle, the JerryScript port, and the start sequence of app_thread_callback
// and run_file_cmd_handler. Code copied from js_runner.c and targets/f21/jerryscript/jerryscript_glue.c keeps its
// shape so the two stay easy to compare.
#include "js_runner_i.h"
#include "js_console.h"
#include "js_fetch.h"
#include "js_headers.h"
#include "js_input.h"
#include "js_interval.h"
#include "js_local_storage.h"
#include "js_request.h"
#include "js_response.h"
#include "js_stubs.h"
#include "js_url.h"

#include <emscripten.h>
#include <stdio.h>
#include <string.h>

#include "host.h"
#include "shim.h"

#define TAG "JsRunner"

JsRunnerStaticContext js_runner_static_context = {
    .app = NULL,
    .is_running = ATOMIC_FLAG_INIT,
};

static JsRunnerApp emu_app;
static FuriString* emu_app_id = NULL;
static char emu_error[1024];
static bool emu_done_reported = false;

// ---------------------------------------------------------------- from js_runner.c

size_t js_runner_thread_context_alloc(size_t context_size) {
    JsRunnerApp* app = js_runner_static_context.app;
    furi_check(!app->jrs_context);
    size_t alloc_size = context_size + app->heap_size;
    app->jrs_context = malloc(alloc_size);
    return alloc_size;
}

void js_runner_thread_context_free(void) {
    JsRunnerApp* app = js_runner_static_context.app;
    furi_check(app->jrs_context);
    free(app->jrs_context);
    app->jrs_context = NULL;
}

void* js_runner_thread_context_get(void) {
    return js_runner_static_context.app->jrs_context;
}

void js_runner_handle_fatal_error(jerry_fatal_code_t code) {
    // On the bar the supervisor shows "JS heap overflow — Restart device" and the runner stays blocked.
    host_fatal((int)code);
}

bool js_runner_get_root_path(FuriString* path) {
    bool result = false;
    WITH_JS_RUNNER_APP(app, {
        if(app->root_path) {
            furi_string_set(path, app->root_path);
            result = true;
        }
    });
    return result;
}

static bool has_active_fetch(JsRunnerAppFetch* instance) {
    for(size_t i = 0; i != FetchArray_size(instance->fetches); ++i) {
        if(*FetchArray_cget(instance->fetches, i)) {
            return true;
        }
    }
    return false;
}

static bool has_active_interval(JsRunnerAppInterval* instance) {
    return !IntervalDict_empty_p(instance->intervals);
}

static bool has_active_input(JsRunnerAppInput* input) {
    return input->subscribed;
}

static bool app_has_background_tasks(JsRunnerApp* app) {
    return !app->script_evaluation_done || has_active_interval(&app->interval) ||
           has_active_fetch(&app->fetch) || has_active_input(&app->input);
}

void js_runner_app_stop_if_done(JsRunnerApp* app) {
    if(!app_has_background_tasks(app) && !emu_done_reported) {
        emu_done_reported = true;
        host_app_done();
    }
}

void js_run_jobs(void) {
    JsRunnerApp* app = js_runner_static_context.app;
    furi_assert(app);

    for(;;) {
        if(app->should_terminate) {
            break;
        }

        bool should_continue = false;

        jerry_value_t jobs_result = jerry_run_jobs();
        if(jerry_value_is_exception(jobs_result)) {
            FURI_LOG_E(TAG, "Exception when running jobs");
            if(jerry_value_is_abort(jobs_result)) {
                FURI_LOG_E(TAG, "Must terminate");
            } else {
                should_continue = true;
            }
        }

        jerry_value_free(jobs_result);

        if(!should_continue) {
            break;
        }
    }
}

void js_runner_add_fetch_thread(JsRunnerApp* app, JsFetch* fetch) {
    for(size_t i = 0; i != FetchArray_size(app->fetch.fetches); ++i) {
        JsFetch** cell = FetchArray_get(app->fetch.fetches, i);
        if(*cell == NULL) {
            *cell = fetch;
            return;
        }
    }
    FetchArray_push_back(app->fetch.fetches, fetch);
}

void js_runner_del_fetch_thread(JsRunnerApp* app, JsFetch* fetch) {
    bool found = false;
    for(size_t i = 0; i != FetchArray_size(app->fetch.fetches); ++i) {
        JsFetch** cell = FetchArray_get(app->fetch.fetches, i);
        if(*cell == fetch) {
            *cell = NULL;
            found = true;
            break;
        }
    }
    furi_check(found);
    js_runner_app_stop_if_done(app);
}

const char* js_runner_app_get_id(const JsRunnerApp* app) {
    return furi_string_get_cstr(app->app_id);
}

void js_runner_heap_destructor(void* object, void* user_p) {
    UNUSED(user_p);
    free(object);
}

// Deferred callbacks before jerry_cleanup arrived after 1.3.1 (FW-1234); build.mjs defines EMU_JS_RUNNER_DEFER when
// the firmware's js_runner_i.h has them.
#ifdef EMU_JS_RUNNER_DEFER
void js_runner_defer(JsRunnerApp* app, JsRunnerDeferredCallback cb, void* context) {
    DeferredList_push_back(app->deferred, (JsRunnerDeferred){.callback = cb, .context = context});
}

void js_runner_cancel_defer(JsRunnerApp* app, JsRunnerDeferredCallback cb, void* context) {
    DeferredList_it_t it;
    DeferredList_it(it, app->deferred);
    while(!DeferredList_end_p(it)) {
        const JsRunnerDeferred* item = DeferredList_cref(it);
        if(item->callback == cb && item->context == context) {
            DeferredList_remove(app->deferred, it);
            break;
        }
        DeferredList_next(it);
    }
}

static void js_runner_run_deferred(JsRunnerApp* app) {
    DeferredList_it_t it;
    DeferredList_it(it, app->deferred);
    while(!DeferredList_end_p(it)) {
        const JsRunnerDeferred* item = DeferredList_cref(it);
        item->callback(item->context);
        DeferredList_next(it);
    }
    DeferredList_reset(app->deferred);
}
#endif

static void arraybuffer_free_callback(
    jerry_arraybuffer_type_t buffer_type,
    uint8_t* buffer_p,
    uint32_t buffer_size,
    void* arraybuffer_user_p,
    void* user_p) {
    UNUSED(buffer_type);
    UNUSED(user_p);
    if(arraybuffer_user_p != NULL) {
        JsRunnerArrayBufferInfo* info = arraybuffer_user_p;
        info->destructor(info->data);
        free(info);
    } else {
        jerry_heap_free(buffer_p, buffer_size);
    }
}

static void external_string_free_callback(jerry_char_t* string_p, jerry_size_t string_size, void* user_p) {
    UNUSED(string_size);
    if(user_p) {
        JsRunnerExternalDataDestructor destructor = user_p;
        destructor(string_p, user_p);
    }
}

// The emulator's watchdog, not the firmware's. On the bar the app's JS has a thread of its own: a loop that never
// returns (for (;;) {}, while (!ready) {}) leaves the system, the web server and long Back working, and a long Back
// stops it here. In the emulator the app's JS runs on the server's only thread, so such a loop would hold the API, the
// window and the agent's tools, and no long Back could reach it. So every EMU_WATCHDOG_EVERY checks (backward branches,
// and promise jobs by an edit in patches.mjs; well under a millisecond of work) the halt handler asks the host whether the slice has run longer than it allows;
// if so, the app is stopped as by a long Back. The check runs no JS and leaves the counters of bar speed alone.
#define EMU_WATCHDOG_EVERY 16384
static uint32_t emu_halt_checks = 0;

static jerry_value_t engine_halt_callback(void* user_p) {
    JsRunnerApp* app = user_p;
    if(!app->should_terminate && ++emu_halt_checks % EMU_WATCHDOG_EVERY == 0 && host_slice_overdue()) {
        app->should_terminate = true;
    }
    if(app->should_terminate) {
        return jerry_string_sz("aborted");
    } else {
        return jerry_undefined();
    }
}

static bool parser_halt_callback(void* user_p) {
    JsRunnerApp* app = user_p;
    return app->should_terminate;
}

static void fetch_event_queue_callback(FuriEventLoopObject* object, void* context) {
    UNUSED(object);
    JsRunnerApp* app = context;
    JsFetchEvent event;
    furi_check(furi_message_queue_get(app->fetch.event_queue, &event, 0) == FuriStatusOk);
    js_fetch_process_event(&event);
    js_run_jobs();
}

static void js_runner_app_set_root_path(JsRunnerApp* app, const char* script_path) {
    if(app->root_path) {
        furi_string_free(app->root_path);
        app->root_path = NULL;
    }
    if(script_path) {
        app->root_path = furi_string_alloc();
        path_extract_dirname(script_path, app->root_path);
    }
}

// ---------------------------------------------------------------- JerryScript port (from jerryscript_glue.c)

size_t jerry_port_context_alloc(size_t context_size) {
    return js_runner_thread_context_alloc(context_size);
}

struct jerry_context_t* jerry_port_context_get(void) {
    return js_runner_thread_context_get();
}

void jerry_port_context_free(void) {
    js_runner_thread_context_free();
}

void jerry_port_init(void) {
}

void jerry_port_log(const char* message) {
    FURI_LOG_D("JSGlue", "%s", message);
}

void jerry_port_fatal(jerry_fatal_code_t code) {
    FURI_LOG_E("JSGlue", "jerryscript fatal error %d", code);
    js_runner_handle_fatal_error(code);
    // The bar suspends the app thread here; the wasm instance cannot continue either.
    abort();
}

void jerry_port_sleep(uint32_t sleep_time) {
    UNUSED(sleep_time);
}

double jerry_port_current_time(void) {
    return host_now();
}

int32_t jerry_port_local_tza(double unix_ms) {
    return host_tza(unix_ms);
}

jerry_char_t* jerry_port_line_read(jerry_size_t* out_size_p) {
    *out_size_p = 0;
    return NULL;
}

void jerry_port_line_free(jerry_char_t* buffer_p) {
    UNUSED(buffer_p);
}

jerry_char_t* jerry_port_path_normalize(const jerry_char_t* path_p, jerry_size_t path_size) {
    UNUSED(path_size);
    FuriString* path_norm = furi_string_alloc();
    path_normalize((const char*)path_p, path_norm, true);
    jerry_char_t* result = malloc(furi_string_size(path_norm) + 1);
    strcpy((char*)result, furi_string_get_cstr(path_norm));
    furi_string_free(path_norm);
    return result;
}

void jerry_port_path_free(jerry_char_t* path_p) {
    free(path_p);
}

jerry_size_t jerry_port_path_base(const jerry_char_t* path_p) {
    const char* last_slash = strrchr((const char*)path_p, '/');
    if(last_slash) {
        return last_slash - (const char*)path_p + 1;
    } else {
        return 0;
    }
}

static FuriString* get_normalized_root_path(const char* file_name_p) {
    FuriString* abs_path = furi_string_alloc();
    if(js_runner_get_root_path(abs_path)) {
        path_append(abs_path, file_name_p);
        FuriString* abs_path_norm = furi_string_alloc();
        path_normalize(furi_string_get_cstr(abs_path), abs_path_norm, false);
        furi_string_free(abs_path);
        return abs_path_norm;
    } else {
        furi_string_free(abs_path);
        return NULL;
    }
}

jerry_char_t* jerry_port_source_read(const char* file_name_p, jerry_size_t* out_size_p) {
    FuriString* abs_path_norm = get_normalized_root_path(file_name_p);
    if(!abs_path_norm) {
        return NULL;
    }
    uint32_t size = 0;
    uint8_t* result = host_file_read(furi_string_get_cstr(abs_path_norm), &size);
    if(result && (size == 0 || size > JS_RUNNER_MAX_SCRIPT_SIZE)) {
        FURI_LOG_E("JSGlue", "File is empty or too large %s", furi_string_get_cstr(abs_path_norm));
        free(result);
        result = NULL;
    }
    furi_string_free(abs_path_norm);
    *out_size_p = size;
    return result;
}

void jerry_port_source_free(jerry_char_t* buffer_p) {
    free(buffer_p);
}

// ---------------------------------------------------------------- console → host

static void emu_console_write(
    JsRunnerConsoleSeverity severity,
    const char* buf,
    size_t size,
    JsRunnerConsoleSeparator separator,
    void* context) {
    UNUSED(context);
    host_console((int)severity, buf, size, (int)separator);
}

// ---------------------------------------------------------------- the emulator's note: unhandled rejections
//
// The bar says nothing of a promise that is rejected with nobody to handle it: the app's error goes nowhere. The
// emulator notes it in the log. Not the firmware's code: JerryScript tells of such promises with
// JERRY_PROMISE_CALLBACK, which the emulator's build turns on (build.mjs) and the firmware's does not. Nothing the
// app sees changes: the callback runs no JS, makes nothing on the JS heap, and the counters of bar speed are put back.
//
// A promise rejected without a handler is held here until the host's call into the runtime is over (emu_unhandled_take,
// after every slice); one that gets a handler meanwhile (await, a .catch() later in the same slice) is let go.

#define EMU_UNHANDLED_MAX 16
#define EMU_WHERE_SIZE 128

typedef struct {
    jerry_value_t promise;
    char where[EMU_WHERE_SIZE]; // where it was rejected, when JS ran then: "main.js:3:5"
} EmuUnhandled;

static EmuUnhandled emu_unhandled[EMU_UNHANDLED_MAX];
static size_t emu_unhandled_count = 0;
static uint32_t emu_unhandled_dropped = 0; // more at once than the list holds
static char emu_unhandled_text[1024];

extern uint32_t emu_vm_ops;
extern uint32_t emu_alloc_bytes;

// A string value into buf, cut to fit (no JS heap).
static void string_to_buf(jerry_value_t value, char* buf, size_t size) {
    jerry_size_t n = jerry_string_to_buffer(value, JERRY_ENCODING_UTF8, (jerry_char_t*)buf, (jerry_size_t)(size - 1));
    buf[n] = '\0';
}

static bool location_of_frame(jerry_frame_t* frame, void* user_p) {
    char* where = user_p;
    const jerry_frame_location_t* location = jerry_frame_location(frame);
    if(!location) return true; // a frame without line info: look further down
    char name[64];
    string_to_buf(location->source_name, name, sizeof(name));
    snprintf(where, EMU_WHERE_SIZE, "%s:%u:%u", name[0] ? name : "<unknown>", (unsigned)location->line, (unsigned)location->column);
    return false;
}

static void promise_event(jerry_promise_event_type_t type, const jerry_value_t object, const jerry_value_t value, void* user_p) {
    UNUSED(value);
    UNUSED(user_p);
    if(type == JERRY_PROMISE_EVENT_REJECT_WITHOUT_HANDLER) {
        if(emu_unhandled_count == EMU_UNHANDLED_MAX) {
            emu_unhandled_dropped++;
            return;
        }
        EmuUnhandled* entry = &emu_unhandled[emu_unhandled_count++];
        // A reference keeps the promise from the garbage collector until the note; it allocates nothing.
        entry->promise = jerry_value_copy(object);
        entry->where[0] = '\0';
        jerry_backtrace_capture(location_of_frame, entry->where);
    } else if(type == JERRY_PROMISE_EVENT_CATCH_HANDLER_ADDED) {
        for(size_t i = 0; i < emu_unhandled_count; i++) {
            if(emu_unhandled[i].promise == object) {
                jerry_value_free(emu_unhandled[i].promise);
                memmove(&emu_unhandled[i], &emu_unhandled[i + 1], (emu_unhandled_count - i - 1) * sizeof(EmuUnhandled));
                emu_unhandled_count--;
                break;
            }
        }
    }
}

// An own data property of an object (no getter, no proxy: no JS runs), or undefined.
static jerry_value_t own_data(jerry_value_t object, const char* name) {
    jerry_value_t result = jerry_undefined();
    if(!jerry_value_is_object(object) || jerry_value_is_proxy(object)) return result;
    jerry_property_descriptor_t desc = jerry_property_descriptor();
    jerry_value_t key = jerry_string_sz(name);
    jerry_value_t found = jerry_object_get_own_prop(object, key, &desc);
    if(jerry_value_is_true(found) && (desc.flags & JERRY_PROP_IS_VALUE_DEFINED)) result = jerry_value_copy(desc.value);
    jerry_value_free(found);
    jerry_value_free(key);
    jerry_property_descriptor_free(&desc);
    return result;
}

static const char* const ERROR_NAMES[] = {
    [JERRY_ERROR_COMMON] = "Error", [JERRY_ERROR_EVAL] = "EvalError", [JERRY_ERROR_RANGE] = "RangeError",
    [JERRY_ERROR_REFERENCE] = "ReferenceError", [JERRY_ERROR_SYNTAX] = "SyntaxError", [JERRY_ERROR_TYPE] = "TypeError",
    [JERRY_ERROR_URI] = "URIError", [JERRY_ERROR_AGGREGATE] = "AggregateError",
};

// What a rejection's reason is, in words, without running any of the app's JS: an Error's type and message and the
// place it was made, a string in quotes, other values as JS writes them.
static void describe_reason(jerry_value_t reason, char* where, char* out, size_t size) {
    char text[512];
    jerry_error_t error = jerry_value_is_proxy(reason) ? JERRY_ERROR_NONE : jerry_error_type(reason);
    if(error != JERRY_ERROR_NONE && (size_t)error < sizeof(ERROR_NAMES) / sizeof(ERROR_NAMES[0])) {
        jerry_value_t message = own_data(reason, "message");
        char said[400] = "";
        if(jerry_value_is_string(message)) string_to_buf(message, said, sizeof(said));
        jerry_value_free(message);
        snprintf(text, sizeof(text), "%s%s%s", ERROR_NAMES[error], said[0] ? ": " : "", said);
        // Where the Error was made: the first line of its stack (JERRY_LINE_INFO), rather than where it was rejected.
        jerry_value_t stack = own_data(reason, "stack");
        if(jerry_value_is_array(stack) && jerry_array_length(stack) > 0) {
            jerry_value_t top = jerry_object_get_index(stack, 0);
            if(jerry_value_is_string(top)) string_to_buf(top, where, EMU_WHERE_SIZE);
            jerry_value_free(top);
        }
        jerry_value_free(stack);
    } else if(jerry_value_is_string(reason)) {
        char said[400];
        string_to_buf(reason, said, sizeof(said));
        snprintf(text, sizeof(text), "\"%s\"", said);
    } else if(jerry_value_is_number(reason)) {
        snprintf(text, sizeof(text), "%.17g", jerry_value_as_number(reason));
    } else if(jerry_value_is_boolean(reason)) {
        snprintf(text, sizeof(text), "%s", jerry_value_is_true(reason) ? "true" : "false");
    } else if(jerry_value_is_null(reason)) {
        snprintf(text, sizeof(text), "null");
    } else if(jerry_value_is_undefined(reason)) {
        snprintf(text, sizeof(text), "undefined");
    } else if(jerry_value_is_symbol(reason)) {
        snprintf(text, sizeof(text), "a symbol");
    } else if(jerry_value_is_bigint(reason)) {
        snprintf(text, sizeof(text), "a BigInt");
    } else {
        snprintf(text, sizeof(text), "an object that is not an Error");
    }
    if(where[0]) snprintf(out, size, "%s, at %s", text, where);
    else snprintf(out, size, "%s", text);
}

// The next promise still rejected with nobody to handle it now that the host's call is over, in words, taken off the
// list; "" when there is none. The host asks until "" after every slice (packages/server/runtime.mjs).
EMSCRIPTEN_KEEPALIVE const char* emu_unhandled_take(void) {
    emu_unhandled_text[0] = '\0';
    uint32_t ops = emu_vm_ops, bytes = emu_alloc_bytes;
    if(emu_unhandled_count > 0) {
        EmuUnhandled entry = emu_unhandled[0];
        memmove(&emu_unhandled[0], &emu_unhandled[1], (emu_unhandled_count - 1) * sizeof(EmuUnhandled));
        emu_unhandled_count--;
        jerry_value_t reason = jerry_promise_result(entry.promise);
        describe_reason(reason, entry.where, emu_unhandled_text, sizeof(emu_unhandled_text));
        jerry_value_free(reason);
        jerry_value_free(entry.promise);
    } else if(emu_unhandled_dropped > 0) {
        snprintf(emu_unhandled_text, sizeof(emu_unhandled_text), "%u more at once", (unsigned)emu_unhandled_dropped);
        emu_unhandled_dropped = 0;
    }
    emu_vm_ops = ops;
    emu_alloc_bytes = bytes;
    return emu_unhandled_text;
}

static void emu_unhandled_clear(void) {
    for(size_t i = 0; i < emu_unhandled_count; i++) jerry_value_free(emu_unhandled[i].promise);
    emu_unhandled_count = 0;
    emu_unhandled_dropped = 0;
}

// ---------------------------------------------------------------- exports

static void record_exception(const char* what, jerry_value_t exception) {
    js_log_exception(TAG, what, exception);
    FuriString* text = js_get_exception_string(exception);
    snprintf(emu_error, sizeof(emu_error), "%s: %s", what, text ? furi_string_get_cstr(text) : "possibly out of memory");
    if(text) furi_string_free(text);
}

// Sets up the app and the engine like js_runner_app_init + app_thread_callback.
EMSCRIPTEN_KEEPALIVE int emu_init(const char* app_id, int heap_kib) {
    JsRunnerApp* app = &emu_app;
    memset(app, 0, sizeof(*app));
    emu_done_reported = false;
    emu_error[0] = '\0';
    emu_app_id = furi_string_alloc_set(app_id);

    app->app_id = emu_app_id;
    app->thread = furi_thread_get_current();
    app->heap_size = (size_t)heap_kib * 1024;
    app->event_loop = furi_event_loop_alloc();
    app->is_idle = furi_event_flag_alloc();
    app->console.callback = emu_console_write;
    app->interval.last_id = 0;
    IntervalDict_init(app->interval.intervals);
    FetchArray_init(app->fetch.fetches);
    app->fetch.event_queue = furi_message_queue_alloc(MAX_FETCH_MESSAGES, sizeof(JsFetchEvent));
    js_runner_app_input_init(&app->input);
    furi_event_loop_subscribe_message_queue(
        app->event_loop, app->fetch.event_queue, FuriEventLoopEventIn, fetch_event_queue_callback, app);
#ifdef EMU_JS_RUNNER_DEFER
    DeferredList_init(app->deferred);
#endif
    js_runner_static_context.app = app;

    jerry_init(JERRY_INIT_EMPTY);
    jerry_halt_handler(1, engine_halt_callback, app);
    jerry_parser_halt_handler(parser_halt_callback, app);
    jerry_arraybuffer_allocator(NULL, arraybuffer_free_callback, NULL);
    jerry_string_external_on_free(external_string_free_callback);
    // The emulator's own: unhandled rejections for its log (see emu_unhandled_take).
    jerry_promise_on_event(JERRY_PROMISE_EVENT_FILTER_ERROR, promise_event, NULL);

    js_setup_console(&app->console);
    js_setup_input_methods();
    js_setup_interval_methods();
    js_setup_url();
    js_setup_headers();
    js_setup_request();
    js_setup_response();
    js_setup_fetch();
    js_setup_local_storage();
    js_setup_stubs();
    return 0;
}

EMSCRIPTEN_KEEPALIVE const char* emu_last_error(void) {
    return emu_error;
}

// Runs the app's entry point like run_file_cmd_handler. 0 ok, 1 file, 2 parse, 3 link, 4 evaluate.
EMSCRIPTEN_KEEPALIVE int emu_run_file(const char* path) {
    JsRunnerApp* app = &emu_app;
    app->script_evaluation_done = false;
    int status = 0;
    js_runner_app_set_root_path(app, path);

    uint32_t file_size = 0;
    uint8_t* buf = host_file_read(path, &file_size);
    if(!buf || file_size == 0 || file_size > JS_RUNNER_MAX_SCRIPT_SIZE) {
        snprintf(emu_error, sizeof(emu_error), "cannot read %s", path);
        free(buf);
        js_runner_app_set_root_path(app, NULL);
        return 1;
    }

    FuriString* path_furi = furi_string_alloc_set_str(path);
    FuriString* filename_furi = furi_string_alloc();
    path_extract_filename(path_furi, filename_furi, false);
    jerry_value_t source_name = js_utf8_string(filename_furi);
    furi_string_free(filename_furi);
    furi_string_free(path_furi);

    jerry_parse_options_t parse_options = {
        .options = JERRY_PARSE_HAS_SOURCE_NAME | JERRY_PARSE_MODULE,
        .source_name = source_name,
    };
    jerry_value_t parse_result = jerry_parse((const jerry_char_t*)buf, file_size, &parse_options);
    free(buf);

    do {
        if(jerry_value_is_exception(parse_result)) {
            record_exception("Error parsing script", parse_result);
            status = 2;
            break;
        }
        jerry_value_t link_result = jerry_module_link(parse_result, NULL, NULL);
        if(jerry_value_is_exception(link_result)) {
            record_exception("Error linking modules", link_result);
            jerry_value_free(link_result);
            status = 3;
            break;
        }
        jerry_value_t evaluate_result = jerry_module_evaluate(parse_result);
        if(jerry_value_is_exception(evaluate_result)) {
            record_exception("Error running script", evaluate_result);
            app->should_terminate = true;
            status = 4;
        }
        js_run_jobs();
        app->script_evaluation_done = true;
        js_runner_app_stop_if_done(app);
        jerry_value_free(evaluate_result);
        jerry_value_free(link_result);
    } while(false);

    jerry_value_free(parse_result);
    jerry_value_free(source_name);
    js_runner_app_set_root_path(app, NULL);
    emu_pump();
    return status;
}

// Force quit (long Back): the halt handler aborts whatever runs next.
EMSCRIPTEN_KEEPALIVE void emu_terminate(void) {
    emu_app.should_terminate = true;
}

// The measure of an app's JS work that bar speed (packages/server/bar-speed.mjs) turns into the bar's time: byte-code
// instructions JerryScript has executed (counted in vm_loop) and bytes it has allocated on its heap (in
// jmem_heap_alloc), where the native work of strings, objects and the garbage collector shows (packages/engine/patches.mjs).
uint32_t emu_vm_ops;
uint32_t emu_alloc_bytes;

EMSCRIPTEN_KEEPALIVE uint32_t emu_vm_ops_count(void) {
    return emu_vm_ops;
}

EMSCRIPTEN_KEEPALIVE uint32_t emu_alloc_bytes_count(void) {
    return emu_alloc_bytes;
}

// Heap size, currently allocated and peak allocated bytes into out[0..2]. Needs JERRY_MEM_STATS.
EMSCRIPTEN_KEEPALIVE int emu_heap_stats(uint32_t* out) {
    jerry_heap_stats_t stats;
    memset(&stats, 0, sizeof(stats));
    if(!jerry_heap_stats(&stats)) return 0;
    out[0] = (uint32_t)stats.size;
    out[1] = (uint32_t)stats.allocated_bytes;
    out[2] = (uint32_t)stats.peak_allocated_bytes;
    return 1;
}

EMSCRIPTEN_KEEPALIVE void emu_cleanup(void) {
#ifdef EMU_JS_RUNNER_DEFER
    js_runner_run_deferred(&emu_app);
#endif
    emu_unhandled_clear();
    jerry_cleanup();
}
