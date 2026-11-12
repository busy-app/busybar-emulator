// The firmware's allocator semantics (furi/core/memmgr.c, memmgr_heap.c) on top of Emscripten's: every allocation
// comes back zeroed, and firmware code relies on it (the LVGL themes in lvgl_addons leave fields unset after malloc).
// realloc is a fresh zeroed block plus a copy, as on the bar; here the copy stops at the old block's end.
//
// What is allocated is counted, now and at its peak, for the host (emu_system_heap): the bar's system heap is the
// RAM the firmware has left, and an app that makes the firmware hold more than that (a fetch body it collects) ends
// there; here the heap grows instead, so the host decides when it is full.
#include <emscripten.h>
#include <malloc.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

void* emscripten_builtin_malloc(size_t size);
void emscripten_builtin_free(void* ptr);

static size_t emu_heap_used = 0;
static size_t emu_heap_peak = 0;

void* malloc(size_t size) {
    void* p = emscripten_builtin_malloc(size ? size : 1);
    if(p) {
        memset(p, 0, size);
        emu_heap_used += malloc_usable_size(p);
        if(emu_heap_used > emu_heap_peak) emu_heap_peak = emu_heap_used;
    }
    return p;
}

void free(void* ptr) {
    if(ptr) emu_heap_used -= malloc_usable_size(ptr);
    emscripten_builtin_free(ptr);
}

void* calloc(size_t count, size_t size) {
    return malloc(count * size);
}

void* realloc(void* ptr, size_t size) {
    if(size == 0) {
        free(ptr);
        return NULL;
    }
    void* p = malloc(size);
    if(ptr) {
        size_t old = malloc_usable_size(ptr);
        memcpy(p, ptr, old < size ? old : size);
        free(ptr);
    }
    return p;
}

// Bytes allocated now and the most allocated at once since the last call into out[0..1]; the peak starts again from
// what is allocated now.
EMSCRIPTEN_KEEPALIVE void emu_system_heap(uint32_t* out) {
    out[0] = (uint32_t)emu_heap_used;
    out[1] = (uint32_t)emu_heap_peak;
    emu_heap_peak = emu_heap_used;
}
