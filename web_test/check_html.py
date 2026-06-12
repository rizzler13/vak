import re

with open("/Users/rizzler/Desktop/vāk/web_test/index.html", "r", encoding="utf-8") as f:
    html = f.read()

# Remove comments
html = re.sub(r"<!--.*?-->", "", html, flags=re.DOTALL)

# Find all opening and closing tags for div, section, main, body, html
tags = re.findall(r"<(/)?(div|section|main|body|html)\b[^>]*>", html, re.IGNORECASE)

stack = []
for is_close, tag_name in tags:
    tag_name = tag_name.lower()
    if not is_close:
        stack.append(tag_name)
    else:
        if not stack:
            print(f"Error: Closed </{tag_name}> but stack is empty")
        else:
            last = stack.pop()
            if last != tag_name:
                print(f"Error: Closed </{tag_name}> but expected </{last}>")

if stack:
    print(f"Error: Unclosed tags remaining: {stack}")
else:
    print("Success: All tags are closed correctly!")
