// Emulator stand-in for applications/services/storage/storage.h: the file API the JS runtime and the GUI use, with the
// firmware's names, values and signatures. storage_shim.c backs it with the host's file system.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <furi.h>
#include <storage/filesystem_api_defines.h>

#ifdef __cplusplus
extern "C" {
#endif

#define STORAGE_ROOT_PREFIX            "/"
#define STORAGE_EXT_PATH_PREFIX        "/ext"
#define STORAGE_BACKUP_PATH_PREFIX     "/bkp"
#define STORAGE_APP_ASSETS_PATH_PREFIX "/assets"
#define STORAGE_APP_DATA_PATH_PREFIX   "/data"
#define APP_DATA_PATH(path)            STORAGE_APP_DATA_PATH_PREFIX "/" path
#define EXT_PATH(path)                 STORAGE_EXT_PATH_PREFIX "/" path
#define APP_ASSETS_PATH(path)          STORAGE_APP_ASSETS_PATH_PREFIX "/" path
#define SHARED_ASSETS_PATH(path)       EXT_PATH("apps_assets/shared/" path)
#define SHARED_ANIM_PATH(path)         SHARED_ASSETS_PATH("animations/" path)
#define SHARED_IMG_PATH(path)          SHARED_ASSETS_PATH("images/" path)
#define SHARED_SOUND_PATH(path)        SHARED_ASSETS_PATH("sounds/" path)
#define RECORD_STORAGE                 "storage"

typedef struct Storage Storage;

File* storage_file_alloc(Storage* storage);
void storage_file_free(File* file);
bool storage_file_open(File* file, const char* path, FS_AccessMode access_mode, FS_OpenMode open_mode);
bool storage_file_close(File* file);
size_t storage_file_read(File* file, void* buff, size_t bytes_to_read);
size_t storage_file_write(File* file, const void* buff, size_t bytes_to_write);
uint64_t storage_file_size(File* file);
bool storage_file_is_open(File* file);
bool storage_file_seek(File* file, uint32_t offset, bool from_start);
uint64_t storage_file_tell(File* file);
bool storage_file_eof(File* file);
bool storage_file_exists(Storage* storage, const char* path);
bool storage_dir_exists(Storage* storage, const char* path);
FS_Error storage_common_stat(Storage* storage, const char* path, FileInfo* fileinfo);
FS_Error storage_file_get_error(File* file);
bool storage_simply_remove_recursive(Storage* storage, const char* path);
// /data/... is the running app's own folder, /ext/apps_data/<app>/... (see emu_app_data_owner).
void storage_common_resolve_path_and_ensure_app_directory(Storage* storage, FuriString* path);
bool storage_simply_mkpath(Storage* storage, const char* path);

// The partitions, which the supervisor checks at start and can remake: always there in the emulator.
FS_Error storage_sd_status(Storage* storage, const char* path);
FS_Error storage_sd_format(Storage* storage, const char* path);
FS_Error storage_sd_make_filesystem(Storage* storage, const char* path);
const char* storage_error_get_desc(FS_Error error_id);

bool storage_dir_open(File* file, const char* path);
bool storage_dir_close(File* file);
bool storage_dir_read(File* file, FileInfo* fileinfo, char* name, uint16_t name_length);

#ifdef __cplusplus
}
#endif
