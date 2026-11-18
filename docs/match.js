
(function (root) {
  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\(.*?\)|\[.*?\]/g, ' ')
      .replace(/\s+-\s+.*$/, ' ')
      .replace(/\b(feat|ft|featuring)\b.*$/, ' ')
      .replace(/&/g, ' et ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/^(the|le|la|les|l)\s+/, '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function isMatch(guess, target) {
    const g = normalize(guess);
    const t = normalize(target);
    if (!g || !t) return false;
    if (g === t) return true;
    const maxLen = Math.max(g.length, t.length);
    if (maxLen >= 4 && 1 - levenshtein(g, t) / maxLen >= 0.8) return true;
    if (g.length >= 4 && t.includes(g) && g.length / t.length >= 0.6) return true;
    return false;
  }

  const api = { normalize, levenshtein, isMatch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Match = api;
})(this);
