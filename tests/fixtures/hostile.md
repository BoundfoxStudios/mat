# Hostile input

Each block below is one of the nine tag names GFM §6.11 filters. None may reach the output alive.

<title>stolen title</title>

<textarea>a & b</textarea>

<style>
body { display: none }
</style>

<xmp>
raw & unparsed
</xmp>

<iframe src="https://example.com"></iframe>

<noembed>
fallback
</noembed>

<noframes>
fallback
</noframes>

<script>alert('xss')</script>

## Attributes

The tagfilter never touches attributes, so these need a second pass.

<img src="x" onerror="alert(1)">

<div onclick="alert(2)" onmouseover="alert(3)">handlers</div>

<a href="javascript:alert(4)">javascript url</a>

<a href="data:text/html,hello">data url</a>

## Indirection

The tagfilter escapes the tag name; an unescaped `<` inside an attribute value climbs back out.

<style title="a<img src=q onerror=window.PWNED=1>b"></style>

SVG carries its own URL attribute, and SMIL installs one at runtime, after every static pass.

<svg><a xlink:href="javascript:window.PWNED=2"><text>xlink</text></a></svg>

<svg><a><animate attributeName="href" values="javascript:window.PWNED=3" begin="0s"/><text>smil</text></a></svg>

These navigate or fetch on their own.

<meta http-equiv="refresh" content="0;url=https://evil.example">

<link rel="stylesheet" href="https://evil.example/track.css">

<form action="https://evil.example/phish"><p>form body survives</p></form>

<a href="vbscript:msgbox(1)">vbscript</a>

## Must survive untouched

![pixel](data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==)

<details>
<summary>A <em>collapsible</em> section</summary>

Body text with a [link](https://example.com).

</details>

| a | b |
| - | - |
| 1 | 2 |

- [x] done
- [ ] open

<svg><a href="./page.html"><text>svg link</text></a></svg>

<plaintext>
