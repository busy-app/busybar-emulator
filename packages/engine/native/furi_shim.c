// Single-threaded Furi for the emulator: the parts of the firmware's OS layer that js_runner and the GUI touch.
//
// The bar runs the app on its own thread with a FuriEventLoop and runs every fetch on a separate thread; the GUI and
// canvas are services with their own threads and loops. Here everything happens on one thread, driven by the host:
//   - message queues are unbounded FIFOs and never block (the firmware's queues hold 32 messages);
//   - an event loop is a list of subscriptions (message queues, semaphores) that emu_pump() serves, for every loop;
//     furi_event_loop_run() only registers the loop, and emu_tick() runs the loops' tick callbacks. An app that runs
//     its loop and then cleans up does so through emu_event_loop_run_then() (patched in, see packages/engine/patches.mjs): the
//     clean-up runs once furi_event_loop_stop() is called, and then the app's thread is over;
//   - a thread's signal callback is kept on the thread, so the loader can ask an app to exit;
//   - waiting on an event flag (api_lock) pumps the loops, which is where the answer comes from;
//   - a thread that sleeps (furi_delay_*) or waits for a record with a timeout gives the other threads a turn: the
//     loops run everything that is ready, except the loop of the thread that waits, and no time passes. A thread that
//     keeps waiting for something that never comes is stopped, with a line in the log (see "waits" below);
//   - records are a name -> pointer table; pubsub calls subscribers right away; mutexes never contend;
//   - event-loop timers are scheduled by the host, which calls emu_timer_fire();
//   - a thread runs its callback at furi_thread_start(). For the fetch thread, whose fetch_run() would block on the
//     network, the messages it posts are held back until the host finishes the request (see fetch_shim.c), so the app
//     sees them in the same order as on the bar: headers, data, done, thread exit.
#include <furi.h>

#include <emscripten.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "host.h"
#include "shim.h"

static void emu_run_loops(void);

// ---------------------------------------------------------------- crash, log, kernel

void emu_furi_crash(const char* message) {
    // furi_check passes small flag values instead of a message to save flash.
    const char* text = ((uintptr_t)message < 0x100) ? "furi_check failed" : message;
    host_log(FuriLogLevelError, "Furi", text);
    host_fatal(-1);
    abort();
}

void __furi_crash_implementation(void) {
    emu_furi_crash("crash");
}

void __furi_halt_implementation(void) {
    emu_furi_crash("halt");
}

// The bar goes down in the middle of what the firmware is doing: nothing of it runs after this.
void emu_halt(bool stuck) {
    host_halt(stuck);
    abort();
}

void furi_log_print_format(FuriLogLevel level, const char* tag, const char* format, ...) {
    char buffer[512];
    va_list args;
    va_start(args, format);
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    host_log(level, tag, buffer);
}

uint32_t furi_ms_to_ticks(uint32_t milliseconds) {
    return milliseconds;
}

// Milliseconds since the module started, like the bar's ticks since boot. (Unix time does not fit: converting it to
// uint32_t saturates in wasm, and LVGL would see a clock that never moves.)
//
// The time the bar's GUI takes to draw. On a bar the GUI's tick is due every 8 ms sharp (furi's event loop counts
// its ticks from the first, prev += 8), but the GUI's thread gets to a tick only once it is done with what it was
// doing, and drawing takes it milliseconds. The clock is the hardware's: a tick that comes after a long draw starts
// late and sees the later time. LVGL reads the clock as it goes (lv_timer_exec keeps the time a timer runs at, read
// before its callback; lv_timer_periodic_handler counts from the end of its last run), so a timer whose period is a
// whole number of ticks then misses its next tick by a millisecond or two and runs a tick later. Which timers run on
// which tick is the firmware's code, unchanged here: lv_timer.c, gui.c, the animation player (anim_player.c, a period
// of 1000 / fps ms), the displays' refresh (16 ms, lv_refr.c; it waits for something to draw) and the back display's
// copy of the front while canvas draws on the front only (front_display_mirror.c, every 40 ms at most). What is not in
// the source is how long a draw takes; that is the emulator's part:
//
//   - each refresh of a display that sends it a frame costs the GUI a time drawn from a range for that display, by a
//     fixed pseudo-random sequence (emu_gui_drew; emu_screen.c calls it once a refresh, however many areas LVGL
//     flushes);
//   - while that time runs, the clock the GUI reads goes on with it: what the GUI does after the draw, in the same
//     pass, sees the later time;
//   - a GUI tick that comes before the GUI is done waits: it runs once the computer's clock has got to the end of the
//     drawing (emu_gui_late_tick), as a bar's GUI gets to an overdue tick, and the ticks that come in the meantime
//     follow it at once. So the clock never runs ahead of the computer's by more than the pass in progress has drawn:
//     a GUI with more to draw than time falls behind, and its animations play slower, never faster, as on a bar;
//   - nothing else costs time (the emulator's own work does not count), and nothing else waits: the other threads'
//     ticks and timers come when they are due.
//
// The ranges come from a stock bar's pace (screen.mjs says how). With them an animation of 60 frames a second (a 16
// ms timer, two ticks) plays about 1.22 times its nominal time, as on a bar; a 30 ms timer (33 frames a second, four
// ticks and 2 ms to spare) misses a tick now and then, about 1.03 times four ticks; and timers of 33 to 40 ms (30 to
// 25 frames a second) run every five ticks, 40 ms, never sooner or later: the copy's long draw, every 40 ms as well,
// settles where it falls between their ticks.
//
// emu_gui_draw_time(front_min, front_max, back_min, back_max, seed) sets the ranges, ms; all 0 is a GUI that draws in
// no time, whose clock is the tick's own. A seed other than 0 starts the sequence again from that state, with nothing
// left to draw; 0 leaves it where it is. It returns the state the sequence was in, which, given back as the seed,
// goes on from there. (The server starts it again when its clock is held, so that a held clock plays the same each
// time, and puts it back when the clock runs again: screen.mjs.)
static double emu_draw_min[2];
static double emu_draw_span[2];
static uint32_t emu_draw_state = 0x9E3779B9;
// When the GUI is done with what it has drawn, ms since the start; the clock reads no earlier than that.
static double emu_gui_free;
// When the latest tick was due, ms since the start.
static double emu_last_tick;
// The latest reading of the clock: it never goes back.
static uint32_t emu_last_reading;
// The GUI's loop (emu_gui_set_loop), the ticks it is owed while it draws, and the timer that gives them to it.
static FuriEventLoop* emu_gui_loop;
static uint32_t emu_gui_owed;
static FuriEventLoopTimer* emu_gui_late_timer;

static double emu_clock_ms(void) {
    static double boot = -1;
    double now = host_now();
    if(boot < 0) boot = now;
    return now - boot;
}

uint32_t furi_get_tick(void) {
    double now = emu_clock_ms();
    if(emu_gui_free > now) now = emu_gui_free;
    uint32_t tick = (uint32_t)(uint64_t)now;
    if(tick < emu_last_reading) tick = emu_last_reading;
    emu_last_reading = tick;
    return tick;
}

void emu_gui_drew(int display) {
    if(display < 0 || display > 1 || emu_draw_min[display] + emu_draw_span[display] <= 0) return;
    // xorshift32
    emu_draw_state ^= emu_draw_state << 13;
    emu_draw_state ^= emu_draw_state >> 17;
    emu_draw_state ^= emu_draw_state << 5;
    double now = emu_clock_ms();
    if(emu_gui_free < now) emu_gui_free = now;
    emu_gui_free += emu_draw_min[display] + emu_draw_span[display] * (emu_draw_state / 4294967296.0);
}

// The whole ms by which the GUI's drawing runs past the computer's clock now (0: the GUI is free).
static uint32_t emu_gui_busy_ms(void) {
    uint64_t free = (uint64_t)emu_gui_free;
    uint64_t now = (uint64_t)emu_clock_ms();
    return free > now ? (uint32_t)(free - now) : 0;
}

static void emu_gui_forget_owed(void) {
    emu_gui_owed = 0;
    if(emu_gui_late_timer) furi_event_loop_timer_stop(emu_gui_late_timer);
}

EMSCRIPTEN_KEEPALIVE uint32_t
    emu_gui_draw_time(double front_min, double front_max, double back_min, double back_max, uint32_t seed) {
    uint32_t state = emu_draw_state;
    emu_draw_min[0] = front_min > 0 ? front_min : 0;
    emu_draw_span[0] = front_max > emu_draw_min[0] ? front_max - emu_draw_min[0] : 0;
    emu_draw_min[1] = back_min > 0 ? back_min : 0;
    emu_draw_span[1] = back_max > emu_draw_min[1] ? back_max - emu_draw_min[1] : 0;
    if(seed) emu_draw_state = seed;
    if(seed || !emu_gui_draws_take_time()) {
        // Nothing left to draw. (A hold waits for that before it starts the sequence again: no tick is owed then.)
        emu_gui_free = 0;
        emu_gui_forget_owed();
    }
    return state;
}

bool emu_gui_draws_take_time(void) {
    return emu_draw_min[0] + emu_draw_span[0] + emu_draw_min[1] + emu_draw_span[1] > 0;
}

// How far the clock, as last read, is ahead of the computer's, ms: never more than one GUI pass draws (tests).
EMSCRIPTEN_KEEPALIVE uint32_t emu_gui_lead(void) {
    uint64_t now = (uint64_t)emu_clock_ms();
    return emu_last_reading > now ? (uint32_t)(emu_last_reading - now) : 0;
}

bool emu_gui_behind(void) {
    double next = emu_last_tick + 8;
    return emu_gui_owed > 0 || (double)emu_last_reading > next || (double)(uint64_t)emu_gui_free > next;
}

void (*emu_sleep_hook)(void) = NULL;

// A sleeping thread: the others get a turn and the GUI draws, and no time passes (see "waits" below).
void furi_delay_tick(uint32_t ticks) {
    emu_wait_turn("a sleep", ticks);
    if(emu_sleep_hook) emu_sleep_hook();
}

void furi_delay_ms(uint32_t milliseconds) {
    furi_delay_tick(milliseconds);
}

uint32_t furi_kernel_get_tick_frequency(void) {
    return 1000;
}

__FuriCriticalInfo __furi_critical_enter(void) {
    __FuriCriticalInfo info = {0};
    return info;
}

void __furi_critical_exit(__FuriCriticalInfo info) {
    (void)info;
}

// ---------------------------------------------------------------- records

typedef struct {
    int unused;
} EmuRecord;

// What a record nobody created opens to: the JS runtime only passes these handles back to the shims.
static EmuRecord emu_record;

#define EMU_MAX_RECORDS (24)

static struct {
    const char* name;
    void* data;
} emu_records[EMU_MAX_RECORDS];

void furi_record_create(const char* name, void* data) {
    for(int i = 0; i < EMU_MAX_RECORDS; i++) {
        if(!emu_records[i].name) {
            emu_records[i].name = name;
            emu_records[i].data = data;
            return;
        }
    }
    emu_furi_crash("too many records");
}

void* furi_record_open(const char* name) {
    for(int i = 0; i < EMU_MAX_RECORDS; i++) {
        if(emu_records[i].name && strcmp(emu_records[i].name, name) == 0) return emu_records[i].data;
    }
    return &emu_record;
}

void furi_record_close(const char* name) {
    (void)name;
}

void furi_record_destroy(const char* name) {
    for(int i = 0; i < EMU_MAX_RECORDS; i++) {
        if(emu_records[i].name && strcmp(emu_records[i].name, name) == 0) {
            emu_records[i].name = NULL;
            emu_records[i].data = NULL;
        }
    }
}

static void* emu_record_find(const char* name) {
    for(int i = 0; i < EMU_MAX_RECORDS; i++) {
        if(emu_records[i].name && strcmp(emu_records[i].name, name) == 0) return emu_records[i].data;
    }
    return NULL;
}

// NULL when nobody has created the record: the JS app launcher's API uses that for "not running". A caller that would
// wait for the record lets the other threads run first: one of them may be about to create it (the BUSY timer waits
// this way for the BUSY program it asked the desktop to start).
void* furi_record_open_ex(const char* name, uint32_t timeout) {
    void* data = emu_record_find(name);
    if(!data && timeout) {
        emu_wait_turn(name, timeout);
        data = emu_record_find(name);
    }
    return data;
}

// ---------------------------------------------------------------- mutexes

struct FuriMutex {
    FuriMutexType type;
};

FuriMutex* furi_mutex_alloc(FuriMutexType type) {
    FuriMutex* mutex = calloc(1, sizeof(FuriMutex));
    mutex->type = type;
    return mutex;
}

void furi_mutex_free(FuriMutex* instance) {
    free(instance);
}

FuriStatus furi_mutex_acquire(FuriMutex* instance, uint32_t timeout) {
    (void)instance;
    (void)timeout;
    return FuriStatusOk;
}

FuriStatus furi_mutex_release(FuriMutex* instance) {
    (void)instance;
    return FuriStatusOk;
}

// ---------------------------------------------------------------- semaphores

struct FuriSemaphore {
    uint32_t max_count;
    uint32_t count;
};

FuriSemaphore* furi_semaphore_alloc(uint32_t max_count, uint32_t initial_count) {
    FuriSemaphore* instance = calloc(1, sizeof(FuriSemaphore));
    instance->max_count = max_count;
    instance->count = initial_count;
    return instance;
}

void furi_semaphore_free(FuriSemaphore* instance) {
    free(instance);
}

// A taken semaphore is released by another loop (the desktop acknowledging an app's exit): run the loops first.
FuriStatus furi_semaphore_acquire(FuriSemaphore* instance, uint32_t timeout) {
    if(instance->count == 0 && timeout) emu_run_loops();
    if(instance->count == 0) return FuriStatusErrorTimeout;
    instance->count--;
    return FuriStatusOk;
}

FuriStatus furi_semaphore_release(FuriSemaphore* instance) {
    if(instance->count >= instance->max_count) return FuriStatusErrorResource;
    instance->count++;
    return FuriStatusOk;
}

uint32_t furi_semaphore_get_count(FuriSemaphore* instance) {
    return instance->count;
}

uint32_t furi_semaphore_get_space(FuriSemaphore* instance) {
    return instance->max_count - instance->count;
}

// ---------------------------------------------------------------- pubsub

struct FuriPubSubSubscription {
    FuriPubSubCallback callback;
    void* context;
    FuriPubSubSubscription* next;
};

struct FuriPubSub {
    FuriPubSubSubscription* first;
};

FuriPubSub* furi_pubsub_alloc(void) {
    return calloc(1, sizeof(FuriPubSub));
}

void furi_pubsub_free(FuriPubSub* pubsub) {
    while(pubsub->first) {
        FuriPubSubSubscription* next = pubsub->first->next;
        free(pubsub->first);
        pubsub->first = next;
    }
    free(pubsub);
}

FuriPubSubSubscription* furi_pubsub_subscribe(FuriPubSub* pubsub, FuriPubSubCallback callback, void* callback_context) {
    FuriPubSubSubscription* s = calloc(1, sizeof(FuriPubSubSubscription));
    s->callback = callback;
    s->context = callback_context;
    s->next = pubsub->first;
    pubsub->first = s;
    return s;
}

void furi_pubsub_unsubscribe(FuriPubSub* pubsub, FuriPubSubSubscription* pubsub_subscription) {
    for(FuriPubSubSubscription** s = &pubsub->first; *s; s = &(*s)->next) {
        if(*s == pubsub_subscription) {
            *s = pubsub_subscription->next;
            free(pubsub_subscription);
            return;
        }
    }
}

void furi_pubsub_publish(FuriPubSub* pubsub, void* message) {
    for(FuriPubSubSubscription* s = pubsub->first; s;) {
        FuriPubSubSubscription* next = s->next;
        s->callback(message, s->context);
        s = next;
    }
}

// ---------------------------------------------------------------- event flags

struct FuriEventFlag {
    uint32_t flags;
};

FuriEventFlag* furi_event_flag_alloc(void) {
    return calloc(1, sizeof(FuriEventFlag));
}

void furi_event_flag_free(FuriEventFlag* instance) {
    free(instance);
}

uint32_t furi_event_flag_set(FuriEventFlag* instance, uint32_t flags) {
    instance->flags |= flags;
    return instance->flags;
}

uint32_t furi_event_flag_clear(FuriEventFlag* instance, uint32_t flags) {
    uint32_t before = instance->flags;
    instance->flags &= ~flags;
    return before;
}

uint32_t furi_event_flag_get(FuriEventFlag* instance) {
    return instance->flags;
}

uint32_t furi_event_flag_wait(FuriEventFlag* instance, uint32_t flags, uint32_t options, uint32_t timeout) {
    (void)options;
    (void)timeout;
    // The flag is set by another service's loop (an api_lock answered by canvas): run the loops first.
    if(!(instance->flags & flags)) emu_run_loops();
    return instance->flags & flags;
}

// ---------------------------------------------------------------- threads

struct FuriThread {
    char name[16];
    FuriThreadCallback callback;
    void* context;
    // Messages posted while the callback ran, held until emu_thread_release().
    EmuHeldMessage* held;
    size_t held_count;
    bool waiting;
    FuriThreadSignalCallback signal_callback;
    void* signal_context;
};

static FuriThread emu_main_thread = {.name = "JsApp"};
static FuriThread* emu_capturing = NULL;

FuriThread* furi_thread_alloc_ex(const char* name, uint32_t stack_size, FuriThreadCallback callback, void* context) {
    (void)stack_size;
    FuriThread* thread = calloc(1, sizeof(FuriThread));
    snprintf(thread->name, sizeof(thread->name), "%s", name ? name : "");
    thread->callback = callback;
    thread->context = context;
    return thread;
}

void furi_thread_free(FuriThread* thread) {
    for(size_t i = 0; i < thread->held_count; i++) free(thread->held[i].data);
    free(thread->held);
    free(thread);
}

FuriThread* emu_capture_thread(void) {
    return emu_capturing;
}

void emu_thread_wait(FuriThread* thread) {
    thread->waiting = true;
}

static void deliver(FuriMessageQueue* queue, const void* data);

void furi_thread_start(FuriThread* thread) {
    FuriThread* outer = emu_capturing;
    emu_capturing = thread;
    thread->callback(thread->context);
    emu_capturing = outer;
    // A thread that didn't hand its work to the host is done: its messages go out now.
    if(!thread->waiting) emu_thread_release(thread, true);
}

void emu_thread_release(FuriThread* thread, bool ok) {
    thread->waiting = false;
    // A failed fetch_run would not have posted "done": keep only the final message (thread exit).
    size_t first = (!ok && thread->held_count > 0) ? thread->held_count - 1 : 0;
    for(size_t i = first; i < thread->held_count; i++) deliver(thread->held[i].queue, thread->held[i].data);
    for(size_t i = 0; i < thread->held_count; i++) free(thread->held[i].data);
    free(thread->held);
    thread->held = NULL;
    thread->held_count = 0;
}

bool furi_thread_join(FuriThread* thread) {
    (void)thread;
    return true;
}

FuriThread* furi_thread_get_current(void) {
    return emu_capturing ? emu_capturing : &emu_main_thread;
}

FuriThreadId furi_thread_get_current_id(void) {
    return (FuriThreadId)furi_thread_get_current();
}

void furi_thread_suspend(FuriThreadId thread_id) {
    (void)thread_id;
}

void furi_thread_set_current_priority(FuriThreadPriority priority) {
    (void)priority;
}

void furi_thread_set_signal_callback(FuriThread* thread, FuriThreadSignalCallback callback, void* context) {
    thread->signal_callback = callback;
    thread->signal_context = context;
}

FuriThreadSignalCallback furi_thread_get_signal_callback(const FuriThread* thread) {
    return thread->signal_callback;
}

bool furi_thread_signal(const FuriThread* thread, uint32_t signal, void* arg) {
    return thread->signal_callback ? thread->signal_callback(signal, arg, thread->signal_context) : false;
}

const char* furi_thread_get_name(FuriThreadId thread_id) {
    return ((FuriThread*)thread_id)->name;
}

// ---------------------------------------------------------------- message queues

struct FuriMessageQueue {
    uint32_t msg_size;
    uint8_t* data;
    size_t head;
    size_t count;
    size_t capacity;
};

FuriMessageQueue* furi_message_queue_alloc(uint32_t msg_count, uint32_t msg_size) {
    FuriMessageQueue* q = calloc(1, sizeof(FuriMessageQueue));
    q->msg_size = msg_size;
    q->capacity = msg_count ? msg_count : 1;
    q->data = malloc(q->capacity * msg_size);
    return q;
}

void furi_message_queue_free(FuriMessageQueue* instance) {
    free(instance->data);
    free(instance);
}

static void deliver(FuriMessageQueue* q, const void* msg) {
    if(q->count == q->capacity) {
        // Unbounded here: the bar's sender would block until the app thread drains the queue.
        size_t capacity = q->capacity * 2;
        uint8_t* data = malloc(capacity * q->msg_size);
        for(size_t i = 0; i < q->count; i++) {
            memcpy(data + i * q->msg_size, q->data + ((q->head + i) % q->capacity) * q->msg_size, q->msg_size);
        }
        free(q->data);
        q->data = data;
        q->head = 0;
        q->capacity = capacity;
    }
    memcpy(q->data + ((q->head + q->count) % q->capacity) * q->msg_size, msg, q->msg_size);
    q->count++;
}

FuriStatus furi_message_queue_put(FuriMessageQueue* instance, const void* msg_ptr, uint32_t timeout) {
    // A sender that would not wait gets "full", as on the bar (the JS app launcher fills its queue up this way when it
    // exits); one that would wait for room gets it, since nobody else runs to make room.
    if(timeout == 0 && !emu_capturing && instance->count == instance->capacity) return FuriStatusErrorResource;
    if(emu_capturing) {
        FuriThread* t = emu_capturing;
        t->held = realloc(t->held, (t->held_count + 1) * sizeof(EmuHeldMessage));
        t->held[t->held_count].queue = instance;
        t->held[t->held_count].data = malloc(instance->msg_size);
        memcpy(t->held[t->held_count].data, msg_ptr, instance->msg_size);
        t->held_count++;
    } else {
        deliver(instance, msg_ptr);
    }
    return FuriStatusOk;
}

FuriStatus furi_message_queue_get(FuriMessageQueue* instance, void* msg_ptr, uint32_t timeout) {
    (void)timeout;
    if(instance->count == 0) return FuriStatusErrorTimeout;
    memcpy(msg_ptr, instance->data + instance->head * instance->msg_size, instance->msg_size);
    instance->head = (instance->head + 1) % instance->capacity;
    instance->count--;
    return FuriStatusOk;
}

uint32_t furi_message_queue_get_count(FuriMessageQueue* instance) {
    return (uint32_t)instance->count;
}

FuriStatus furi_message_queue_reset(FuriMessageQueue* instance) {
    instance->head = 0;
    instance->count = 0;
    return FuriStatusOk;
}

// ---------------------------------------------------------------- event loop

#define EMU_MAX_SUBSCRIPTIONS (8)
#define EMU_MAX_LOOPS         (8)

typedef enum {
    EmuObjectQueue,
    EmuObjectSemaphore,
} EmuObjectType;

typedef struct {
    void* object; // NULL: the slot is free
    EmuObjectType type;
    FuriEventLoopEvent event;
    FuriEventLoopEventCallback callback;
    void* context;
} EmuSubscription;

struct FuriEventLoop {
    EmuSubscription subs[EMU_MAX_SUBSCRIPTIONS];
    FuriEventLoopTickCallback tick_callback;
    void* tick_context;
    // Custom events set and not yet handled, which emu_pump() passes to the callback all at once.
    FuriEventLoopCustomCallback custom_callback;
    void* custom_context;
    uint32_t custom_events;
    // An app's loop: what runs after furi_event_loop_run() returns, on the thread that ran it.
    void (*then)(void* context);
    void* then_context;
    FuriThread* thread;
    bool stop_requested;
    // The thread that allocated the loop, whose default signal handler it may be.
    FuriThread* owner;
    // The loop's thread is inside a sleep or a timed wait (emu_wait_turn): until it returns, the loop handles nothing
    // and is not finished, like a blocked thread.
    bool waiting;
};

void (*emu_thread_exit_hook)(FuriThread* thread) = NULL;

static FuriEventLoop* emu_loops[EMU_MAX_LOOPS];

// The loops whose callbacks are running now, the outermost first: the threads that are in the middle of something.
// The last one is the thread that a sleep or a wait blocks. Only compared, never followed: a loop may be freed by its
// own callback. Callbacks nested deeper than the list holds are counted and not listed.
#define EMU_MAX_RUNNING (16)

static FuriEventLoop* emu_running[EMU_MAX_RUNNING];
static uint32_t emu_running_count;

// Runs one callback of a loop, as that loop's thread.
#define EMU_AS_LOOP(loop, call)                                                    \
    do {                                                                           \
        if(emu_running_count < EMU_MAX_RUNNING) emu_running[emu_running_count] = (loop); \
        emu_running_count++;                                                       \
        call;                                                                      \
        emu_running_count--;                                                       \
    } while(0)

bool emu_loop_in_callback(const FuriEventLoop* loop) {
    // Past the end of the list nobody knows: say yes.
    if(emu_running_count > EMU_MAX_RUNNING) return true;
    for(uint32_t i = 0; i < emu_running_count; i++) {
        if(emu_running[i] == loop) return true;
    }
    return false;
}

// event_loop.c: a thread with no signal handler of its own stops its loop on FuriSignalExit, which is how the loader
// closes apps such as the JS app launcher.
static bool emu_event_loop_signal_callback(uint32_t signal, void* arg, void* context) {
    (void)arg;
    if(signal != FuriSignalExit) return false;
    furi_event_loop_stop(context);
    return true;
}

FuriEventLoop* furi_event_loop_alloc(void) {
    for(int i = 0; i < EMU_MAX_LOOPS; i++) {
        if(!emu_loops[i]) {
            FuriEventLoop* instance = calloc(1, sizeof(FuriEventLoop));
            instance->owner = furi_thread_get_current();
            if(!instance->owner->signal_callback) {
                furi_thread_set_signal_callback(instance->owner, emu_event_loop_signal_callback, instance);
            }
            emu_loops[i] = instance;
            return instance;
        }
    }
    emu_furi_crash("too many event loops");
}

void furi_event_loop_free(FuriEventLoop* instance) {
    for(int i = 0; i < EMU_MAX_LOOPS; i++) {
        if(emu_loops[i] == instance) emu_loops[i] = NULL;
    }
    if(instance->owner->signal_callback == emu_event_loop_signal_callback && instance->owner->signal_context == instance) {
        furi_thread_set_signal_callback(instance->owner, NULL, NULL);
    }
    free(instance);
}

// A service's thread would block here; the emulator's loops are driven by emu_pump() and emu_tick() instead.
void furi_event_loop_run(FuriEventLoop* instance) {
    (void)instance;
}

// furi_event_loop_run(loop) followed by then(context), for an app whose thread cleans up after its loop stops.
void emu_event_loop_run_then(FuriEventLoop* instance, void (*then)(void* context), void* context) {
    instance->then = then;
    instance->then_context = context;
    instance->thread = furi_thread_get_current();
}

// Whether a thread still runs a loop that has not been stopped (its main function returned through
// emu_event_loop_run_then).
bool emu_thread_is_running(FuriThread* thread) {
    for(int l = 0; l < EMU_MAX_LOOPS; l++) {
        if(emu_loops[l] && emu_loops[l]->then && emu_loops[l]->thread == thread) return true;
    }
    return false;
}

void furi_event_loop_stop(FuriEventLoop* instance) {
    instance->stop_requested = true;
}

// Loops that were asked to stop: their apps clean up (which frees the loop) and their threads end.
static bool emu_finish_stopped_loops(void) {
    bool finished = false;
    for(int l = 0; l < EMU_MAX_LOOPS; l++) {
        FuriEventLoop* loop = emu_loops[l];
        if(!loop || !loop->stop_requested || !loop->then || loop->waiting) continue;
        void (*then)(void*) = loop->then;
        void* context = loop->then_context;
        FuriThread* thread = loop->thread;
        loop->then = NULL;
        // The clean-up frees the loop: what follows is not that loop's any more.
        EMU_AS_LOOP(loop, then(context));
        if(emu_thread_exit_hook) emu_thread_exit_hook(thread);
        finished = true;
    }
    return finished;
}

void furi_event_loop_tick_set(FuriEventLoop* instance, uint32_t interval, FuriEventLoopTickCallback callback, void* context) {
    (void)interval;
    instance->tick_callback = callback;
    instance->tick_context = context;
}

// The host calls this at the GUI's tick period (8 ms).
EMSCRIPTEN_KEEPALIVE void emu_tick(void) {
    emu_last_tick = emu_clock_ms();
    for(int i = 0; i < EMU_MAX_LOOPS; i++) {
        FuriEventLoop* loop = emu_loops[i];
        if(!loop || !loop->tick_callback) continue;
        // The GUI still draws, or still has ticks to catch up on: this one waits behind them (see the top).
        if(loop == emu_gui_loop && (emu_gui_owed || emu_gui_busy_ms())) {
            emu_gui_owed++;
            if(!furi_event_loop_timer_is_running(emu_gui_late_timer))
                furi_event_loop_timer_start(emu_gui_late_timer, emu_gui_busy_ms() ? emu_gui_busy_ms() : 1);
            continue;
        }
        EMU_AS_LOOP(loop, loop->tick_callback(loop->tick_context));
    }
    emu_pump();
}

// The GUI's overdue ticks, once the computer's clock has got to the end of its drawing: one after another, as a bar's
// event loop catches up, until one of them draws again and the rest wait for that.
static void emu_gui_late_tick(void* context) {
    (void)context;
    while(emu_gui_owed) {
        uint32_t busy = emu_gui_busy_ms();
        if(busy) {
            furi_event_loop_timer_start(emu_gui_late_timer, busy);
            return;
        }
        emu_gui_owed--;
        if(emu_gui_loop->tick_callback) emu_gui_loop->tick_callback(emu_gui_loop->tick_context);
    }
}

void emu_gui_set_loop(FuriEventLoop* loop) {
    emu_gui_loop = loop;
    emu_gui_late_timer = furi_event_loop_timer_alloc(loop, emu_gui_late_tick, FuriEventLoopTimerTypeOnce, NULL);
}

static void emu_subscribe(
    FuriEventLoop* instance,
    void* object,
    EmuObjectType type,
    FuriEventLoopEvent event,
    FuriEventLoopEventCallback callback,
    void* context) {
    for(int i = 0; i < EMU_MAX_SUBSCRIPTIONS; i++) {
        if(!instance->subs[i].object) {
            instance->subs[i] = (EmuSubscription){object, type, event, callback, context};
            return;
        }
    }
    emu_furi_crash("too many event loop subscriptions");
}

void furi_event_loop_subscribe_message_queue(
    FuriEventLoop* instance,
    FuriMessageQueue* message_queue,
    FuriEventLoopEvent event,
    FuriEventLoopEventCallback callback,
    void* context) {
    emu_subscribe(instance, message_queue, EmuObjectQueue, event, callback, context);
}

void furi_event_loop_subscribe_semaphore(
    FuriEventLoop* instance,
    FuriSemaphore* semaphore,
    FuriEventLoopEvent event,
    FuriEventLoopEventCallback callback,
    void* context) {
    emu_subscribe(instance, semaphore, EmuObjectSemaphore, event, callback, context);
}

void furi_event_loop_unsubscribe(FuriEventLoop* instance, FuriEventLoopObject* object) {
    for(int i = 0; i < EMU_MAX_SUBSCRIPTIONS; i++) {
        if(instance->subs[i].object == (void*)object) instance->subs[i].object = NULL;
    }
}

void furi_event_loop_set_custom_event_callback(FuriEventLoop* instance, FuriEventLoopCustomCallback callback, void* context) {
    instance->custom_callback = callback;
    instance->custom_context = context;
}

void furi_event_loop_set_custom_event(FuriEventLoop* instance, uint32_t events) {
    instance->custom_events |= events;
}

// Whether a subscription's object is ready: a queue has messages; a semaphore can be taken (In) or given (Out).
static bool emu_ready(const EmuSubscription* s) {
    if(s->type == EmuObjectQueue) return ((FuriMessageQueue*)s->object)->count > 0;
    const FuriSemaphore* semaphore = s->object;
    return (s->event & FuriEventLoopEventMask) == FuriEventLoopEventOut ? semaphore->count < semaphore->max_count :
                                                                          semaphore->count > 0;
}

// How many pumps are running, one inside another, and how many sleeps and timed waits the firmware has made since
// the host last called in (see "waits" below).
static uint32_t emu_pump_depth;
static uint32_t emu_wait_count;

// Runs subscribed callbacks while their objects are ready, one call at a time, like the firmware's loops; then lets
// stopped apps finish. A loop whose thread is in a sleep or a timed wait is left alone.
static void emu_run_loops(void) {
    emu_pump_depth++;
    bool progressed = true;
    while(progressed) {
        progressed = false;
        for(int l = 0; l < EMU_MAX_LOOPS; l++) {
            for(int i = 0; i < EMU_MAX_SUBSCRIPTIONS; i++) {
                FuriEventLoop* loop = emu_loops[l];
                if(!loop || loop->stop_requested || loop->waiting) break;
                EmuSubscription s = loop->subs[i];
                if(s.object && emu_ready(&s)) {
                    EMU_AS_LOOP(loop, s.callback((FuriEventLoopObject*)s.object, s.context));
                    progressed = true;
                }
            }
            FuriEventLoop* loop = emu_loops[l];
            if(loop && !loop->stop_requested && !loop->waiting && loop->custom_events && loop->custom_callback) {
                uint32_t events = loop->custom_events;
                loop->custom_events = 0;
                EMU_AS_LOOP(loop, loop->custom_callback(events, loop->custom_context));
                progressed = true;
            }
        }
        if(emu_finish_stopped_loops()) progressed = true;
    }
    emu_pump_depth--;
}

// What a call from the host ends with: the loops handle what the call brought.
void emu_pump(void) {
    // The waits are counted anew from here, and anew once the call is over (see "waits" below).
    if(emu_pump_depth == 0) emu_wait_count = 0;
    emu_run_loops();
    if(emu_pump_depth == 0) emu_wait_count = 0;
}

// ---------------------------------------------------------------- waits
//
// On a bar a thread that sleeps, or waits a while for a record to appear, stands still while the other threads go on,
// and firmware code relies on it: the BUSY timer asks the desktop to start the BUSY program and polls until the
// program is there (busy_timer_util.c). Here all of them share one thread, so the one that waits has to let the
// others run:
//
//   - a sleep or a timed wait is a turn for the other threads: every loop but the waiting thread's own runs what is
//     ready, down to apps finishing and starting. The waiting thread's loop takes no events meanwhile and is not
//     finished, which is what "blocked" means on a bar, so its events keep their order. Then the wait is over. No
//     time passes in it: the host's timers and the GUI's tick run between calls into the module, never inside one;
//   - a wait made inside a turn takes a turn of its own, without the loops that wait already. Turns nest no deeper
//     than EMU_MAX_LOOPS (past that a wait is no turn), and each of them ends: it only handles what is ready;
//   - a thread that waits again and again for something that does not come would never return to the host. After
//     EMU_WAIT_LIMIT waits it is stopped: the reason goes to the log and the module halts (emu_halt), upon which the
//     host restarts the emulated bar. That is the emulator's own doing, and a difference from a bar: there the thread
//     would go on polling while the rest of the bar runs (the firmware neither starts nor feeds a watchdog, as far as
//     its code shows; not tried on a bar). Here nothing else runs until the thread returns, so it has to be stopped.
//     The waits are counted from where a call's emu_pump() begins and again from where it ends (every call from the
//     host that runs firmware code ends with it): what a call waits before its pump and what it waits inside it are
//     counted apart, and the waits of one call are never added to those of the next, however fast calls follow one
//     another (the ticks a host catches up on after a stall).
//
// What stays as it was: a queue with no room answers "full" at once to a sender that would not wait, a record nobody
// waits for is NULL at once, and waits on a flag or a semaphore run all the loops, the waiting one too.

#define EMU_WAIT_LIMIT (10000)

static uint32_t emu_turn_depth;

void emu_wait_turn(const char* what, uint32_t ticks) {
    if(++emu_wait_count > EMU_WAIT_LIMIT) {
        char text[200];
        snprintf(
            text,
            sizeof(text),
            "The firmware waited %u times in a row for something that did not happen (the last wait: %s, %u ticks). "
            "The BUSY Bar is stuck and restarts.",
            (unsigned)EMU_WAIT_LIMIT,
            what,
            (unsigned)ticks);
        host_log(FuriLogLevelError, "Emulator", text);
        emu_halt(true);
    }
    // Every loop waits already: nobody is left to take a turn.
    if(emu_turn_depth >= EMU_MAX_LOOPS) return;
    // The thread that waits: the loop whose callback is running, if it is still there (its clean-up frees it).
    FuriEventLoop* current = (emu_running_count > 0 && emu_running_count <= EMU_MAX_RUNNING) ? emu_running[emu_running_count - 1] : NULL;
    FuriEventLoop* loop = NULL;
    for(int i = 0; i < EMU_MAX_LOOPS; i++) {
        if(emu_loops[i] && emu_loops[i] == current) loop = current;
    }
    // A loop that waits already is the thread of an outer wait, further down the stack: it stays blocked.
    bool mark = loop && !loop->waiting;
    if(mark) loop->waiting = true;
    emu_turn_depth++;
    emu_run_loops();
    emu_turn_depth--;
    if(mark) loop->waiting = false;
}

// For the engine's own tests: a thread with a loop of its own and two messages waiting for it. It handles the first
// by sleeping `times` times in a row, as a loop that polls for something does; the second must not reach it before
// it is done with the first.
typedef struct {
    FuriMessageQueue* queue;
    uint32_t times;
    uint32_t slept;
    bool first_done;
    bool overtaken;
} EmuWaitProbe;

static void emu_wait_probe_message(FuriEventLoopObject* object, void* context) {
    (void)object;
    EmuWaitProbe* probe = context;
    uint32_t message = 0;
    furi_message_queue_get(probe->queue, &message, 0);
    if(message == 1) {
        for(uint32_t i = 0; i < probe->times; i++) {
            furi_delay_tick(1);
            probe->slept++;
        }
        probe->first_done = true;
    } else if(!probe->first_done) {
        probe->overtaken = true;
    }
}

/**
 * For the engine's own tests: a call from the host in which a thread sleeps `times` times in a row while another
 * message waits in its queue. Returns the number of sleeps made, or UINT32_MAX (-1 to the host) if the thread's loop
 * took the second message while the thread was asleep; past the limit of waits the module halts instead.
 */
EMSCRIPTEN_KEEPALIVE uint32_t emu_wait_probe(uint32_t times) {
    EmuWaitProbe probe = {.queue = furi_message_queue_alloc(2, sizeof(uint32_t)), .times = times};
    FuriEventLoop* loop = furi_event_loop_alloc();
    furi_event_loop_subscribe_message_queue(loop, probe.queue, FuriEventLoopEventIn, emu_wait_probe_message, &probe);
    for(uint32_t message = 1; message <= 2; message++) furi_message_queue_put(probe.queue, &message, FuriWaitForever);
    emu_pump();
    furi_event_loop_unsubscribe(loop, (FuriEventLoopObject*)probe.queue);
    furi_event_loop_free(loop);
    furi_message_queue_free(probe.queue);
    return probe.overtaken ? UINT32_MAX : probe.slept;
}

// ---------------------------------------------------------------- event loop timers

struct FuriEventLoopTimer {
    // The loop the timer belongs to: its callback runs on that loop's thread.
    FuriEventLoop* loop;
    FuriEventLoopTimerCallback callback;
    FuriEventLoopTimerType type;
    void* context;
    uint32_t interval;
    bool running;
};

FuriEventLoopTimer* furi_event_loop_timer_alloc(
    FuriEventLoop* instance,
    FuriEventLoopTimerCallback callback,
    FuriEventLoopTimerType type,
    void* context) {
    FuriEventLoopTimer* timer = calloc(1, sizeof(FuriEventLoopTimer));
    timer->loop = instance;
    timer->callback = callback;
    timer->type = type;
    timer->context = context;
    return timer;
}

void furi_event_loop_timer_free(FuriEventLoopTimer* timer) {
    if(timer->running) host_timer_stop(timer);
    free(timer);
}

void furi_event_loop_timer_start(FuriEventLoopTimer* timer, uint32_t interval) {
    if(timer->running) host_timer_stop(timer);
    timer->interval = interval;
    timer->running = true;
    host_timer_start(timer, interval, timer->type == FuriEventLoopTimerTypePeriodic);
}

void furi_event_loop_timer_restart(FuriEventLoopTimer* timer) {
    furi_event_loop_timer_start(timer, timer->interval);
}

void furi_event_loop_timer_stop(FuriEventLoopTimer* timer) {
    if(timer->running) host_timer_stop(timer);
    timer->running = false;
}

bool furi_event_loop_timer_is_running(const FuriEventLoopTimer* timer) {
    return timer->running;
}

uint32_t furi_event_loop_timer_get_interval(const FuriEventLoopTimer* timer) {
    return timer->interval;
}

EMSCRIPTEN_KEEPALIVE void emu_timer_fire(FuriEventLoopTimer* timer) {
    if(!timer->running) return;
    if(timer->type == FuriEventLoopTimerTypeOnce) timer->running = false;
    // The callback may free the timer (a finished setTimeout), so nothing touches it afterwards.
    EMU_AS_LOOP(timer->loop, timer->callback(timer->context));
    emu_pump();
}
