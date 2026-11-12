
#if defined(LV_LVGL_H_INCLUDE_SIMPLE)
#include "lvgl.h"
#elif defined(LV_BUILD_TEST)
#include "../lvgl.h"
#else
#include "lvgl/lvgl.h"
#endif


#ifndef LV_ATTRIBUTE_MEM_ALIGN
#define LV_ATTRIBUTE_MEM_ALIGN
#endif

#ifndef LV_ATTRIBUTE_I_ERROR_BACK_11X11
#define LV_ATTRIBUTE_I_ERROR_BACK_11X11
#endif

static const
LV_ATTRIBUTE_MEM_ALIGN LV_ATTRIBUTE_LARGE_CONST LV_ATTRIBUTE_I_ERROR_BACK_11X11
uint8_t I_error_back_11x11_map[] = {

    0x4c,0x70,0x47,0x00,0xff,0xff,0xff,0xff,

    0x0e,0x00,
    0x31,0x80,
    0x40,0x40,
    0x44,0x40,
    0x84,0x20,
    0x84,0x20,
    0x80,0x20,
    0x44,0x40,
    0x40,0x40,
    0x31,0x80,
    0x0e,0x00,

};

const lv_image_dsc_t I_error_back_11x11 = {
  .header.magic = LV_IMAGE_HEADER_MAGIC,
  .header.cf = LV_COLOR_FORMAT_I1,
  .header.flags = 0,
  .header.w = 11,
  .header.h = 11,
  .header.stride = 2,
  .header.reserved_2 = 0,
  .data_size = sizeof(I_error_back_11x11_map),
  .data = I_error_back_11x11_map,
  .reserved = NULL,
};

