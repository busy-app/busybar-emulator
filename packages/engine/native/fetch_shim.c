// lib/fetch for the emulator: the same API (lib/fetch/fetch.h), with the request carried out by the host.
//
// On the bar, js_fetch.c runs fetch_run() on its own thread; it blocks until the response is in, calling the header
// and data callbacks as it goes, then posts "done" and "thread exit". Here fetch_run() hands the request to the host
// and returns at once, while the thread's messages are held (furi_shim.c). The host then reports through
// emu_fetch_headers/data/error and emu_fetch_finish, which call the same callbacks and release the held messages.
#include <fetch/fetch.h>

#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "host.h"
#include "shim.h"

struct Fetch {
    void* context;
    FetchRxDataCallback rx_data_callback;
    FetchHeaderCallback header_callback;
    FetchErrorCallback error_callback;
    FetchProgressCallback progress_callback;
    FuriThread* thread;
    bool running;
    bool stopped;
};

Fetch* fetch_alloc(void) {
    return calloc(1, sizeof(Fetch));
}

void fetch_free(Fetch* instance) {
    // The host forgets this request: no callbacks may reach a freed instance.
    host_fetch_stop(instance);
    free(instance);
}

void fetch_set_callback_context(Fetch* instance, void* context) {
    instance->context = context;
}

void fetch_set_rx_data_callback(Fetch* instance, FetchRxDataCallback callback) {
    instance->rx_data_callback = callback;
}

void fetch_set_header_callback(Fetch* instance, FetchHeaderCallback callback) {
    instance->header_callback = callback;
}

void fetch_set_error_callback(Fetch* instance, FetchErrorCallback callback) {
    instance->error_callback = callback;
}

void fetch_set_progress_callback(Fetch* instance, FetchProgressCallback callback) {
    instance->progress_callback = callback;
}

// Appends `s` to `out` as a JSON string literal.
static size_t json_string(char* out, size_t pos, size_t cap, const char* s) {
    pos += snprintf(out + pos, pos < cap ? cap - pos : 0, "\"");
    for(; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if(c == '"' || c == '\\') pos += snprintf(out + pos, pos < cap ? cap - pos : 0, "\\%c", c);
        else if(c < 0x20) pos += snprintf(out + pos, pos < cap ? cap - pos : 0, "\\u%04x", c);
        else pos += snprintf(out + pos, pos < cap ? cap - pos : 0, "%c", c);
    }
    pos += snprintf(out + pos, pos < cap ? cap - pos : 0, "\"");
    return pos;
}

FetchStatus fetch_run(Fetch* instance, const FetchRequest* request) {
    char headers[4096];
    size_t pos = snprintf(headers, sizeof(headers), "[");
    for(uint32_t i = 0; i < request->headers.count; i++) {
        if(i) pos += snprintf(headers + pos, pos < sizeof(headers) ? sizeof(headers) - pos : 0, ",");
        pos = json_string(headers, pos, sizeof(headers), request->headers.data[i]);
    }
    snprintf(headers + pos, pos < sizeof(headers) ? sizeof(headers) - pos : 0, "]");

    instance->thread = emu_capture_thread();
    instance->running = true;
    if(instance->thread) emu_thread_wait(instance->thread);
    host_fetch_start(
        instance,
        request->url,
        request->method ? request->method : "GET",
        headers,
        request->body.data,
        request->body.length,
        request->tls_config.client_cert_info.type == TlsClientCertTypeDevice);
    // The outcome is decided in emu_fetch_finish; for now the thread carries on as if the request succeeded.
    return FetchStatusOk;
}

void fetch_stop(Fetch* instance) {
    if(instance->running && !instance->stopped) {
        instance->stopped = true;
        host_fetch_stop(instance);
        // Like an aborted fetch_run on the bar: no "done", only the thread exit.
        instance->running = false;
        if(instance->thread) emu_thread_release(instance->thread, false);
        emu_pump();
    }
}

EMSCRIPTEN_KEEPALIVE void emu_fetch_headers(Fetch* instance, const void* data, size_t size) {
    if(instance->running && instance->header_callback) instance->header_callback(data, size, instance->context);
    emu_pump();
}

EMSCRIPTEN_KEEPALIVE void emu_fetch_data(Fetch* instance, const void* data, size_t size) {
    if(instance->running && instance->rx_data_callback) instance->rx_data_callback(data, size, instance->context);
    emu_pump();
}

EMSCRIPTEN_KEEPALIVE void emu_fetch_error(Fetch* instance, const char* message) {
    if(instance->running && instance->error_callback) instance->error_callback(message, instance->context);
    emu_pump();
}

EMSCRIPTEN_KEEPALIVE void emu_fetch_finish(Fetch* instance, int ok) {
    if(!instance->running) return;
    instance->running = false;
    if(instance->thread) emu_thread_release(instance->thread, ok != 0);
    emu_pump();
}
