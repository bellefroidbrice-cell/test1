// Tendances : YouTube Data API v3 (clé gratuite de l'utilisateur, appelée depuis son navigateur).
// Classement par vitesse de croissance = vues par heure depuis la mise en ligne.

const API = "https://www.googleapis.com/youtube/v3";

function isoDuration(s) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || "") || [];
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

async function get(path, params) {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg.replace(/<[^>]+>/g, ""));
  }
  return data;
}

export async function findTrending({ key, query, days = 7, minDuration = 180, lang = "fr" }) {
  const after = new Date(Date.now() - days * 86400_000).toISOString();
  const search = await get("search", {
    part: "snippet", type: "video", q: query, order: "viewCount",
    publishedAfter: after, maxResults: "50", relevanceLanguage: lang, key,
  });
  const ids = (search.items || []).map((i) => i.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const vids = await get("videos", { part: "snippet,statistics,contentDetails", id: ids.join(","), key });
  const now = Date.now();
  return (vids.items || [])
    .map((v) => {
      const views = +v.statistics.viewCount || 0;
      const likes = +v.statistics.likeCount || 0;
      const comments = +v.statistics.commentCount || 0;
      const ageH = Math.max(1, (now - new Date(v.snippet.publishedAt).getTime()) / 3600_000);
      const vph = views / ageH;
      const engagement = views ? (likes + 3 * comments) / views : 0;
      return {
        id: v.id,
        title: v.snippet.title,
        channel: v.snippet.channelTitle,
        thumb: v.snippet.thumbnails?.medium?.url,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        duration: isoDuration(v.contentDetails.duration),
        views, ageH, vph, engagement,
        score: vph * (1 + 5 * engagement),
      };
    })
    .filter((v) => v.duration >= minDuration)
    .sort((a, b) => b.score - a.score);
}

export function compact(n) {
  return new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
