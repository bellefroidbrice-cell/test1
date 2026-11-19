# ClipForge 🎬 — trouve et découpe les meilleurs moments (GTA 6 & co)

Outil en ligne de commande qui :

1. **trouve les vidéos qui montent le plus vite** sur YouTube (vues/heure depuis la mise en ligne),
2. **analyse** chaque vidéo pour repérer les moments forts,
3. **découpe** les meilleurs passages en **clips verticaux 9:16** prêts pour TikTok / Shorts / Reels
   (fond flouté, titre incrusté, sous-titres auto, son normalisé à -14 LUFS, miniature).

## Installation

```bash
# FFmpeg est requis : https://ffmpeg.org/download.html  (macOS : brew install ffmpeg)
pip install -r requirements.txt
pip install faster-whisper   # optionnel : sous-titres auto + détection de réactions verbales
```

## Utilisation

```bash
# 1. Trouver les vidéos GTA 6 qui explosent en ce moment (7 derniers jours)
python -m clipforge discover "GTA 6 gameplay" --days 7 --limit 50

# 2. Découper les 5 meilleurs moments d'une vidéo (URL ou fichier local)
python -m clipforge clip "https://www.youtube.com/watch?v=XXXX" -n 5 -l 30

# Version complète : titre + sous-titres FR + image zoomée
python -m clipforge clip ma_session_gta6.mp4 -n 8 -l 25 --zoom 1.4 \
    --title "IL S'EST FAIT ARRÊTER EN 3 SECONDES" --subs --lang fr

# Enchaîner : traiter directement les 3 meilleures vidéos trouvées par discover
python -m clipforge clip --from-discover output/discover.json --top 3

# Juste voir les timestamps sans exporter
python -m clipforge clip video.mp4 --dry-run
```

Chaque vidéo produit un dossier `output/<titre>/` avec `clip_01.mp4…`, une miniature `.jpg` par clip,
`report.json` et `report.md` (timestamps, score, raison du choix, légende + hashtags suggérés).

## Comment le « meilleur moment » est choisi

Chaque seconde de la vidéo reçoit un score qui combine :

| Signal | Ce qu'il détecte | Poids par défaut |
|---|---|---|
| `heatmap` | la courbe **« Moments les plus revus »** de YouTube (quand dispo) — le meilleur indicateur | 1.6 |
| `audio` | pics sonores par rapport au niveau ambiant : cris, explosions, fous rires | 1.0 |
| `keywords` | réactions verbales (« no way », « c'est pas possible », « la police »…) via Whisper (`--keywords`/`--subs`) | 0.8 |
| `scene` | changements de plan rapides = action | 0.6 |

Les clips sont choisis gloutonnement autour des pics, sans chevauchement ; le pic est placé à ~35 % du clip
(`--hook`) pour avoir un peu de contexte puis la chute, et les coupes sont recalées sur un silence proche
pour ne pas couper une phrase. Ajuste les poids avec `--weight audio=2 --weight scene=0.3`.

## Options utiles

| Option | Effet |
|---|---|
| `-n 5` / `-l 30` | nombre de clips / durée (s) |
| `--format vertical\|crop\|original` | 9:16 fond flouté (défaut), 9:16 recadré au centre, ou format d'origine |
| `--zoom 1.4` | agrandit l'image en mode vertical (gameplay plus lisible sur téléphone) |
| `--title "…{n}…"` | texte en haut de l'écran (`{n}` = numéro du clip) |
| `--subs --lang fr` | sous-titres mot-à-mot incrustés |
| `--extra-words "wasted" "busted"` | mots-clés de hype supplémentaires |

## ⚠️ Droits d'auteur — à lire avant de monétiser

Re-publier les vidéos d'autres créateurs sans autorisation = strikes, démonétisation, voire suppression du compte.
Pour **gagner de l'argent légalement** avec ce clipping :

- **Ton propre gameplay** (le plus sûr) : enregistre tes sessions GTA 6 et laisse l'outil trouver les meilleurs moments.
  Rockstar autorise en général le contenu vidéo de ses jeux, mais vérifie leur politique actuelle.
- **Campagnes de clipping rémunérées** : beaucoup de streamers/créateurs paient des clippeurs au millier de vues
  (plateformes de type « clipping campaigns » / programmes de créateurs). Tu as alors l'autorisation explicite.
- **Avec l'accord du créateur** : demande-le, et crédite-le toujours (le `report.md` met son nom dans la légende).
- Ajoute de la valeur (commentaire, montage, sous-titres, contexte) : le simple re-upload est rarement monétisable
  sur YouTube/TikTok (politique « contenu réutilisé »).
