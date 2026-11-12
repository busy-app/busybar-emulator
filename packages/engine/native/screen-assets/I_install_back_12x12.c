
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

#ifndef LV_ATTRIBUTE_I_INSTALL_BACK_12X12
#define LV_ATTRIBUTE_I_INSTALL_BACK_12X12
#endif

static const
LV_ATTRIBUTE_MEM_ALIGN LV_ATTRIBUTE_LARGE_CONST LV_ATTRIBUTE_I_INSTALL_BACK_12X12
uint8_t I_install_back_12x12_map[] = {

    0x4c,0x70,0x47,0x00,0xff,0xff,0xff,0xff,

    0x2a,0x80,
    0x7f,0xc0,
    0xc0,0x60,
    0x5f,0x40,
    0xdf,0x60,
    0x5f,0x40,
    0xdf,0x60,
    0x5f,0x40,
    0xc0,0x60,
    0x7f,0xc0,
    0x2a,0x80,
    0x00,0x00,

};

const lv_image_dsc_t I_install_back_12x12 = {
  .header.magic = LV_IMAGE_HEADER_MAGIC,
  .header.cf = LV_COLOR_FORMAT_I1,
  .header.flags = 0,
  .header.w = 12,
  .header.h = 12,
  .header.stride = 2,
  .header.reserved_2 = 0,
  .data_size = sizeof(I_install_back_12x12_map),
  .data = I_install_back_12x12_map,
  .reserved = NULL,
};

