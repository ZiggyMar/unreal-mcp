"""Which of the plugin's includes exist in 5.6 but not 5.8?

Those are the ones that moved, or that only ever resolved through a deprecation shim. Finding them
one build at a time costs three minutes of compiling per include; finding them all costs one pass
over two file lists.
"""
import io, os, re, glob

def load(path):
    # Map "trailing/path/like/this.h" -> full path, for every suffix of every header. Includes are
    # written relative to a module's Public/ or Classes/ dir, and there is no single root to join
    # against, so match on suffixes instead of trying to reconstruct the include paths.
    by_suffix = {}
    with io.open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            full = line.strip().replace("\\", "/")
            if not full:
                continue
            parts = full.split("/")
            # Only the last few segments can plausibly be an include spelling.
            for n in range(1, min(5, len(parts)) + 1):
                by_suffix.setdefault("/".join(parts[-n:]), full)
    return by_suffix

idx58 = load(r"F:\temp\claude\idx58.txt")
idx56 = load(r"F:\temp\claude\idx56.txt")
print("indexed: 5.8 has %d include spellings, 5.6 has %d" % (len(idx58), len(idx56)))

src_root = r"F:\MCP\unreal-mcp\UnrealMCPBridge\Source"
sources = []
for dirpath, _dirs, files in os.walk(src_root):
    for f in files:
        if f.endswith((".cpp", ".h")):
            sources.append(os.path.join(dirpath, f))

# The plugin's own headers are not engine headers; skip them.
own = set()
for s in sources:
    own.add(os.path.basename(s))

inc_re = re.compile(r'^\s*#\s*include\s+"([^"]+)"', re.M)
seen = {}
for s in sources:
    text = io.open(s, encoding="utf-8", errors="replace").read()
    for m in inc_re.finditer(text):
        spelling = m.group(1)
        if os.path.basename(spelling) in own:
            continue
        seen.setdefault(spelling, []).append(os.path.basename(s))

print("plugin references %d distinct engine headers" % len(seen))

missing_58 = []
missing_both = []
for spelling, users in sorted(seen.items()):
    in56 = spelling in idx56
    in58 = spelling in idx58
    if in56 and not in58:
        missing_58.append((spelling, users, idx56[spelling]))
    elif not in56 and not in58:
        missing_both.append((spelling, users))

print("")
if missing_58:
    print("MOVED OR REMOVED IN 5.8 (%d):" % len(missing_58))
    for spelling, users, where in missing_58:
        base = os.path.basename(spelling)
        # Where did it go? Look for the same basename anywhere in 5.8.
        alt = [k for k in idx58 if k.endswith("/" + base) and k.count("/") <= 3]
        hint = ("  -> 5.8 has it as: " + ", ".join(sorted(alt)[:3])) if alt else "  -> gone from 5.8 entirely"
        print("  %-55s used by %s" % (spelling, ", ".join(sorted(set(users)))))
        print(hint)
else:
    print("MOVED OR REMOVED IN 5.8: none")

print("")
if missing_both:
    print("NOT FOUND IN EITHER INDEX (%d) - probably plugin/module headers outside Engine/Source:" % len(missing_both))
    for spelling, users in missing_both[:25]:
        print("  %-55s used by %s" % (spelling, ", ".join(sorted(set(users)))))
