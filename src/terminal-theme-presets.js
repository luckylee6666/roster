export async function seedThemePresets({
  themes = [],
  entries = [],
  hasMarker,
  markMarker,
  saveThemes,
  dirty = false,
}) {
  const nextThemes = themes.map(theme => ({ ...theme }));
  const pendingEntries = entries.filter(([marker]) => !hasMarker(marker));
  let changed = dirty;

  pendingEntries.forEach(([, preset]) => {
    if (!nextThemes.some(theme => theme.id === preset.id)) {
      nextThemes.push({ ...preset });
      changed = true;
    }
  });

  let savedThemes = nextThemes;
  if (changed) {
    try {
      const persistedThemes = await saveThemes(nextThemes);
      if (Array.isArray(persistedThemes)) savedThemes = persistedThemes;
    } catch (error) {
      return { themes: nextThemes, saved: false, error };
    }
  }

  pendingEntries.forEach(([marker]) => markMarker(marker));
  return { themes: savedThemes, saved: true, error: null };
}
