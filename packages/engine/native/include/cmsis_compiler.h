// Emulator stand-in for CMSIS: there are no interrupts in the wasm build, so the masks always read as zero.
#pragma once
#include <stdint.h>

static inline uint32_t __get_PRIMASK(void) {
    return 0;
}

static inline uint32_t __get_IPSR(void) {
    return 0;
}
