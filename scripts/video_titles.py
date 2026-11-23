"""Short display titles. Each channel's YouTube titles carry SEO tails, numbering and emoji separators."""
import re

# Emoji, pictographs, flags, tag sequences and joiners: Luke uses them as separators.
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿⬀-⯿⌀-⏿️‍\U000E0000-\U000E007F]+")
MIN_WORDS_CHARS = 12
MAX_CHARS = 55


def clean_korean(title):
    t = title
    t = re.sub(r'【[^】]*[a-zA-Z]{2,}[^】]*】\s*', '', t)
    t = re.sub(r'\([^)]*\)', lambda m: m.group(0) if re.search(r'[가-힣]', m.group(0)) else '', t)
    t = re.sub(r'^Didi의\s+한국문화\s+Podcast\s*', '', t, flags=re.IGNORECASE)
    t = t.split('|')[0]
    t = t.split('✶')[0]
    t = re.sub(r'\s{2,}', ' ', t).strip()
    t = re.sub(r'[\s·\-–—]+$', '', t).strip()
    return t or title


def clean_english(title):
    t = re.sub(r'^\s*\d+\.\s+', '', title)                      # "868. Title"
    t = re.sub(r'\[[^\]]*\]', ' | ', t)                          # "[1009]", "[BONUS]", "[P64]" end a title
    t = re.sub(r'\((?![^)]*\bpart\b)[^)]*\)', ' ', t, flags=re.IGNORECASE)  # keep "(Part 2)"
    parts = [p.strip(" -–—:/,") for p in re.split(EMOJI.pattern + r'|\s\|\s|\|', t)]
    parts = [p for p in parts if p]
    if not parts:
        return title.strip()
    short = parts[0]
    # "Books 📚 Farts 💨 & Ghosts" — a stub before the first emoji borrows the next piece.
    for extra in parts[1:]:
        if len(short) >= MIN_WORDS_CHARS:
            break
        short = f"{short} {extra}"
    if len(short) > MAX_CHARS and ' / ' in short:
        short = short.split(' / ')[0]
    short = re.sub(r'\s{2,}', ' ', short).strip(" -–—:/&,")
    return short or title.strip()


def clean_title(title, lang="ko"):
    return clean_korean(title) if lang == "ko" else clean_english(title)
