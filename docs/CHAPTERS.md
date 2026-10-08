# Chapters — names, numbers and skipping, the same in Audex (Android) and Webdex (web)

> Kept identical in `jonsjsj/audex-web` (`docs/CHAPTERS.md`) and `jonsjsj/codexaudio`
> (`docs/17-chapters.md`). Change it in both, or neither.

## What is shown

A chapter reads **`Chapter 33: The Gate`** — on the player's title screen (the chapter playing now), in the chapter
list, on the mini player, on the book page's chapter list and (Webdex) on the lock-screen / media-session card.
Front and back matter — opening credits, contents, dedication, prologue, epilogue, acknowledgements — stays in the
list as its own named entry **without a number**, like the contents of a printed book.

## The number is the book's, not the row's

Audiobook chapter lists hold front matter that the book's own numbering doesn't count, so numbering by position
made the book's Chapter 25 show as 26. Rules (`lib/chapters.ts` / `ChapterLabels` in `:core:domain`, tested with
the same cases in both repos), applied top to bottom of the list:

1. A title that is front/back matter (case-insensitive, whole title): opening/end credits, credits, title page,
   copyright, dedication, contents / table of contents, epigraph, foreword, preface, prologue, introduction,
   map(s), acknowledg(e)ments, about the author, author's note, epilogue, afterword, glossary, cast (of
   characters), also by…, excerpt…, preview…, appendix…, the end, "Part One/Two/…/N/IV" → label is the title,
   no number.
2. A title that already names a number — `Chapter 33`, `Chapter 33: Name`, `Chapter 33 - Name`, `Ch. 33`,
   `Chapter Thirty-Three`, `33. Name`, `33: Name`, `33` → that number; the rest is the name.
3. Any other title (`The Gate`) → the next number after the previous chapter (starts at 1; continues from an
   explicit number, so `Chapter 7` followed by `The next one` gives 8).

Label: `Chapter <n>: <name>`, or `Chapter <n>` when there is no name.

## Skipping chapters

Next to the 30-second skip buttons (both back and forward) there are **previous chapter** and **next chapter**
buttons: `[ ⏮ ] [ ⟲30 ] [ ▶ ] [ ⟳30 ] [ ⏭ ]`.

* **Next** goes to the start of the next chapter (disabled on the last one).
* **Previous** goes to the start of the current chapter — or, within its first 3 seconds, to the one before.
* A book with no chapters: both disabled. Webdex also wires the OS media-session previous/next track to these.
* A jump of 2 minutes or more drops the usual automatic "Left off" bookmark (see BOOKMARKS.md).

The ebook reader's own chapter list is the book's table of contents and is shown as the book has it.
