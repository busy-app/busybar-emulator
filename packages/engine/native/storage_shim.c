// The storage file API for the emulator: whole files are read from and written back to the host on open/close;
// a directory is listed by the host when it is opened.
#include <storage/storage.h>

#include <stdlib.h>
#include <string.h>

#include "host.h"

struct File {
    char* path;
    uint8_t* data;
    size_t size;
    size_t capacity;
    size_t pos;
    bool open;
    bool writable;
    bool dirty;
    FS_Error error;
    // An open directory: the host's listing, one "d name" or "f name" line per entry, and the next line to read.
    char* listing;
    char* next_entry;
};

// Whose /data folder a path in /data/... is; NULL leaves such paths as they are. Set by the screen module (the app the
// loader runs).
const char* (*emu_app_data_owner)(void) = NULL;

File* storage_file_alloc(Storage* storage) {
    (void)storage;
    return calloc(1, sizeof(File));
}

bool storage_file_close(File* file) {
    if(!file->open) return false;
    bool ok = true;
    if(file->writable && file->dirty) ok = host_file_write(file->path, file->data, file->size);
    free(file->path);
    free(file->data);
    file->path = NULL;
    file->data = NULL;
    file->size = file->capacity = file->pos = 0;
    file->open = file->writable = file->dirty = false;
    free(file->listing);
    file->listing = file->next_entry = NULL;
    return ok;
}

void storage_file_free(File* file) {
    storage_file_close(file);
    free(file);
}

bool storage_file_open(File* file, const char* path, FS_AccessMode access_mode, FS_OpenMode open_mode) {
    if(file->open) storage_file_close(file);
    uint32_t size = 0;
    uint8_t* data = NULL;
    if(!(open_mode & FSOM_CREATE_ALWAYS)) data = host_file_read(path, &size);
    if(!data && (open_mode & FSOM_OPEN_EXISTING)) {
        file->error = FSE_NOT_EXIST;
        return false;
    }
    if(data && (open_mode & FSOM_CREATE_NEW)) {
        free(data);
        file->error = FSE_EXIST;
        return false;
    }
    file->error = FSE_OK;
    file->path = strdup(path);
    file->data = data;
    file->size = file->capacity = data ? size : 0;
    file->pos = (open_mode & FSOM_OPEN_APPEND) ? file->size : 0;
    file->open = true;
    file->writable = (access_mode & FSAM_WRITE) != 0;
    // A created file exists even if nothing is written to it.
    file->dirty = file->writable && !data;
    return true;
}

size_t storage_file_read(File* file, void* buff, size_t bytes_to_read) {
    if(!file->open) return 0;
    size_t n = file->size - file->pos;
    if(n > bytes_to_read) n = bytes_to_read;
    memcpy(buff, file->data + file->pos, n);
    file->pos += n;
    return n;
}

size_t storage_file_write(File* file, const void* buff, size_t bytes_to_write) {
    if(!file->open || !file->writable) return 0;
    size_t end = file->pos + bytes_to_write;
    if(end > file->capacity) {
        size_t capacity = end * 2;
        file->data = realloc(file->data, capacity);
        file->capacity = capacity;
    }
    memcpy(file->data + file->pos, buff, bytes_to_write);
    file->pos = end;
    if(end > file->size) file->size = end;
    file->dirty = true;
    return bytes_to_write;
}

uint64_t storage_file_size(File* file) {
    return file->open ? file->size : 0;
}

bool storage_file_is_open(File* file) {
    return file->open;
}

bool storage_file_seek(File* file, uint32_t offset, bool from_start) {
    if(!file->open) return false;
    size_t pos = from_start ? offset : file->pos + offset;
    if(pos > file->size) pos = file->size;
    file->pos = pos;
    return true;
}

uint64_t storage_file_tell(File* file) {
    return file->open ? file->pos : 0;
}

bool storage_file_eof(File* file) {
    return !file->open || file->pos >= file->size;
}

bool storage_file_exists(Storage* storage, const char* path) {
    FileInfo info;
    return storage_common_stat(storage, path, &info) == FSE_OK && !(info.flags & FSF_DIRECTORY);
}

bool storage_dir_exists(Storage* storage, const char* path) {
    (void)storage;
    char* listing = host_dir_list(path);
    free(listing);
    return listing != NULL;
}

FS_Error storage_common_stat(Storage* storage, const char* path, FileInfo* fileinfo) {
    (void)storage;
    uint32_t size = 0;
    uint8_t* data = host_file_read(path, &size);
    if(!data) return FSE_NOT_EXIST;
    free(data);
    if(fileinfo) {
        fileinfo->flags = 0;
        fileinfo->size = size;
    }
    return FSE_OK;
}

bool file_info_is_dir(const FileInfo* file_info) {
    return file_info->flags & FSF_DIRECTORY;
}

FS_Error storage_file_get_error(File* file) {
    return file->error;
}

bool storage_dir_open(File* file, const char* path) {
    if(file->open) storage_file_close(file);
    char* listing = host_dir_list(path);
    if(!listing) {
        file->error = FSE_NOT_EXIST;
        return false;
    }
    file->listing = file->next_entry = listing;
    file->open = true;
    file->error = FSE_OK;
    return true;
}

bool storage_dir_close(File* file) {
    return storage_file_close(file);
}

bool storage_dir_read(File* file, FileInfo* fileinfo, char* name, uint16_t name_length) {
    if(!file->listing || !*file->next_entry) {
        file->error = FSE_NOT_EXIST;
        return false;
    }
    char* line = file->next_entry;
    char* end = strchr(line, '\n');
    size_t length = end ? (size_t)(end - line) : strlen(line);
    file->next_entry = end ? end + 1 : line + length;
    if(fileinfo) {
        fileinfo->flags = line[0] == 'd' ? FSF_DIRECTORY : 0;
        fileinfo->size = 0;
    }
    if(name && name_length) {
        size_t n = length > 2 ? length - 2 : 0;
        if(n >= name_length) n = name_length - 1;
        memcpy(name, line + 2, n);
        name[n] = '\0';
    }
    file->error = FSE_OK;
    return true;
}

bool storage_simply_remove_recursive(Storage* storage, const char* path) {
    (void)storage;
    return host_remove(path);
}

void storage_common_resolve_path_and_ensure_app_directory(Storage* storage, FuriString* path) {
    (void)storage;
    const char* owner = emu_app_data_owner ? emu_app_data_owner() : NULL;
    if(owner && furi_string_start_with_str(path, STORAGE_APP_DATA_PATH_PREFIX)) {
        furi_string_replace_at(path, 0, strlen(STORAGE_APP_DATA_PATH_PREFIX), EXT_PATH("apps_data/"));
        furi_string_replace_at(path, strlen(EXT_PATH("apps_data/")), 0, owner);
    }
}

bool storage_simply_mkpath(Storage* storage, const char* path) {
    (void)storage;
    (void)path;
    return true;
}
