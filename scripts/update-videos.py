#!/usr/bin/env python3
"""Fetch every channel's episode list from the YouTube Data API (run by the Update Videos workflow)."""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from video_titles import clean_title  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CHANNELS_FILE = ROOT / "data" / "channels.json"
VIDEOS_DIR = ROOT / "public" / "data" / "videos"
API = "https://www.googleapis.com/youtube/v3/"


def api(endpoint, **params):
    url = API + endpoint + "?" + urllib.parse.urlencode({**params, "key": os.environ["YOUTUBE_API_KEY"]})
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def fetch_playlist(playlist_id, lang):
    videos, page_token = [], None
    while True:
        params = {"part": "snippet", "playlistId": playlist_id, "maxResults": 50}
        if page_token:
            params["pageToken"] = page_token
        data = api("playlistItems", **params)
        for item in data["items"]:
            s = item["snippet"]
            vid = s["resourceId"]["videoId"]
            thumb = s["thumbnails"].get("medium", s["thumbnails"].get("default", {})).get("url", f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg")
            videos.append({"id": vid, "title": clean_title(s["title"], lang), "published": s["publishedAt"][:10], "thumbnail": thumb})
        page_token = data.get("nextPageToken")
        if not page_token:
            return videos


def parse_duration(value):
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', value or '')
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0) if m else 0


def fetch_durations(video_ids):
    durations = {}
    for i in range(0, len(video_ids), 50):
        for item in api("videos", part="contentDetails", id=",".join(video_ids[i:i + 50]))["items"]:
            durations[item["id"]] = parse_duration(item["contentDetails"]["duration"])
    return durations


def select(videos, channel):
    """Drop trailers/shorts and unaired premieres where a channel asks for a minimum length; keep the newest N."""
    min_duration = channel.get("minDuration", 0)
    kept = [v for v in videos if not min_duration or v.get("duration", 0) >= min_duration]
    kept.sort(key=lambda v: v["published"], reverse=True)
    return kept[:channel["limit"]] if channel.get("limit") else kept


def update_channel(channel):
    all_videos = {}
    for playlist_id in channel["playlists"]:
        for video in fetch_playlist(playlist_id, channel.get("lang", "ko")):
            if video["id"] not in all_videos and video["title"] not in ("Private video", "Deleted video"):
                all_videos[video["id"]] = video
    durations = fetch_durations(list(all_videos))
    for vid, video in all_videos.items():
        if durations.get(vid):
            video["duration"] = durations[vid]
    videos = select(all_videos.values(), channel)

    out = VIDEOS_DIR / f"{channel['id']}.json"
    try:
        old_count = len(json.loads(out.read_text(encoding="utf-8")).get("videos", []))
    except FileNotFoundError:
        old_count = 0
    # An API hiccup must not wipe the list: allow at most 5 fewer episodes.
    if old_count > 0 and len(videos) < old_count - 5:
        print(f"⚠️  {channel['name']}: 视频数从 {old_count} 降至 {len(videos)}，跳过本次更新")
        return
    out.write_text(json.dumps({"channelId": channel["channelId"], "channelName": channel["name"], "videos": videos}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{channel['name']}: {len(videos)} videos (was {old_count})")


def update_avatars(channels):
    changed = False
    for channel in channels:
        if channel.get("avatar"):
            continue
        try:
            items = api("channels", part="snippet", id=channel["channelId"]).get("items", [])
            if items:
                thumbs = items[0]["snippet"]["thumbnails"]
                channel["avatar"] = (thumbs.get("medium") or thumbs.get("default"))["url"]
                changed = True
                print(f"{channel['id']}: avatar updated")
        except Exception as exc:
            print(f"{channel['id']}: avatar fetch failed: {exc}")
    if changed:
        CHANNELS_FILE.write_text(json.dumps(channels, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    channels = json.loads(CHANNELS_FILE.read_text(encoding="utf-8"))
    for channel in channels:
        update_channel(channel)
    update_avatars(channels)


if __name__ == "__main__":
    main()
