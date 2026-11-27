-- Ajustes de lectura de KOReader parecidos al lector de Amazon.
-- Se corre en el Kindle, con KOReader cerrado, desde /mnt/us/koreader:
--   ./luajit /ruta/a/reading_defaults.lua
-- Cambia los valores predeterminados y saca los ajustes de diseño guardados en
-- cada libro de /mnt/us/libros (no toca progreso, notas ni marcadores).

package.path = "frontend/?.lua;common/?.lua;" .. package.path
local dump = require("dump")

local DEFAULTS = {
    cre_font = "Bookerly",
    copt_embedded_fonts = 0,
    copt_font_base_weight = 0.5,
    copt_font_size = 24,
    copt_line_spacing = 125,
    copt_h_page_margins = { 30, 30 },
    copt_t_page_margin = 25,
    copt_b_page_margin = 25,
}

-- Ajustes por libro que tapan los predeterminados.
local PER_BOOK_LAYOUT = {
    "font_face", "copt_font_size", "copt_line_spacing", "copt_h_page_margins",
    "copt_t_page_margin", "copt_b_page_margin", "copt_embedded_fonts", "copt_font_base_weight",
}

local function load(path)
    local ok, t = pcall(dofile, path)
    assert(ok and type(t) == "table", "no se pudo leer " .. path)
    return t
end

-- Escribe a un temporal, lo vuelve a leer para validar y recién ahí reemplaza.
local function save(path, t)
    local tmp = path .. ".kindle-admin-tmp"
    local f = assert(io.open(tmp, "w"))
    f:write("-- " .. path .. "\nreturn " .. dump(t) .. "\n")
    f:close()
    load(tmp)
    assert(os.rename(tmp, path))
end

local settings_path = "settings.reader.lua"
local settings = load(settings_path)
for k, v in pairs(DEFAULTS) do settings[k] = v end
save(settings_path, settings)
print("predeterminados actualizados")

local p = io.popen('ls -d /mnt/us/libros/*.sdr/metadata.*.lua 2>/dev/null')
for path in p:lines() do
    local book = load(path)
    for _, k in ipairs(PER_BOOK_LAYOUT) do book[k] = nil end
    if book.style_tweaks then book.style_tweaks.margin_body_0 = nil end
    save(path, book)
    print("libro: " .. path)
end
p:close()
