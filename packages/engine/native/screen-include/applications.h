// The list of programs fbt generates from the application.fam files (lib/firmware_applications_*/applications.h): the
// part the settings menu and the debug app list read. The emulator's list is in emu_settings.c.
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifndef COUNT_OF
#define COUNT_OF(x) (sizeof(x) / sizeof(x[0]))
#endif

typedef int32_t (*FuriThreadCallback)(void* context);

typedef enum {
    FlipperInternalApplicationFlagDefault = 0,
    FlipperInternalApplicationFlagInsomniaSafe = (1 << 0),
} FlipperInternalApplicationFlag;

typedef struct {
    const FuriThreadCallback app;
    const char* name;
    const char* appid;
    const size_t stack_size;
    const FlipperInternalApplicationFlag flags;
} FlipperInternalApplication;

extern const FlipperInternalApplication FLIPPER_SETTINGS_APPS[];
extern const size_t FLIPPER_SETTINGS_APPS_COUNT;

extern const FlipperInternalApplication FLIPPER_DEBUG_APPS[];
extern const size_t FLIPPER_DEBUG_APPS_COUNT;
