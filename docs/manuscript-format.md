# Manuscript format (research for export)

What publishers and agents expect from a submitted novel manuscript, written so that a DOCX or Typst generator can
reproduce the layout exactly. Every rule lists its sources, the **default** Novel uses and the **options** it exposes
(`ManuscriptSettings`, `src/features/export/settings`). Sources were read on **2026-11-18** (see "Sources").

How to read it:

- **Default** is what the Standard (modern) preset produces. **Options** are the alternatives the settings expose.
- Where sources disagree, the default follows William Shunn's "Proper Manuscript Format" (the reference most editors
  and agents point to; SFWA recommends it) and the disagreement is listed under the rule.
- An agent's or publisher's own guidelines always override all of this ("check the market's guidelines" is the one rule
  every source repeats). The export wizard therefore shows the settings and does not lock them.
- Lengths are inches unless noted. 1 in = 72 pt = 25.4 mm. Letter is 8.5 x 11 in (612 x 792 pt); A4 is 210 x 297 mm
  (595.28 x 841.89 pt).
- "Text area" is the page inside the margins (Letter with 1 in margins: 6.5 x 9 in; A4 with 1 in margins: 6.27 x 9.69 in).

## Summary of defaults

| Rule | Default (Standard preset) | Options | Setting |
|---|---|---|---|
| Paper | Letter in the Americas, A4 elsewhere, from the OS locale | Letter, A4 | `paper` |
| Margins | 1 in on all four sides | any; 30 mm (1.18 in) is the Australian agency value | `margins` |
| Font | Times New Roman 12 pt, black | Classic preset: Courier New 12 pt | `fontFamily`, `fontSizePt`, `preset` |
| Line spacing | Double | 1.5 (UK agencies), single | `lineSpacing` |
| Paragraphs | First line indented 0.5 in, no space between paragraphs | indent size | `firstLineIndentIn` |
| First paragraph | Indented like any other | not indented | `indentFirstParagraph` |
| Alignment | Left-aligned, ragged right, no hyphenation | none | (fixed) |
| Sentence spacing | One space | Classic preset: two | `sentenceSpacing` |
| Emphasis | Italics | Classic preset: underline | `italics` |
| Title page | Separate page: contact block upper left, word count upper right, title one third down, by-line below | contact, agent line, word count each switchable | `titlePage` |
| Word count | "about 80,000 words": the real count, rounded to the nearest 100 (nearest 500 from 20,000 words) | nearest 100 / 500 / 1,000, exact | `wordCountRounding` |
| Running header | `Surname / Title / page`, flush right, from the first text page, not on the title page | other orders, page only, none; title in capitals | `header` |
| Page numbers | Continuous through the whole manuscript, 1 on the first text page | (fixed) | `header.startPage` |
| Chapter opening | New page, heading centred one third of the text-area height down | 0 to 0.5 (fraction) | `chapterDropFraction` |
| Scene break | `#` centred on its own line | `* * *`, any text up to 20 characters | `sceneBreak` |
| End marker | None | centred END / THE END | `endMarker` |
| Footnotes | Real footnotes at the foot of the page | endnotes (not yet an option; see "Footnotes") | (W2) |
| Outputs | DOCX and PDF | either | `outputs` |

The Classic preset changes only the type: Courier New 12 pt, underline for italics, two spaces after a sentence.

## Page setup

### Paper size

- **Rule.** US and Canada: Letter. The rest of the English-speaking world, including the UK, Australia and New Zealand:
  A4. [S-shunn-paper]
- **Default.** From the OS locale: Letter for the Americas (US, CA, MX and a handful of Latin American regions), A4 for
  everywhere else. A locale with no region (`en`) gets Letter. The wizard shows the choice.
  Implemented by `paperFromLocale()`.
- **Options.** Letter, A4.
- **Sources.** [S-shunn-paper]; Get a Literary Agent also specifies Letter for US agents [S-gala]; A4 agencies [S-blake],
  [S-curtisbrown-au].

### Margins

- **Rule.** One inch on all four sides. [S-shunn-story] [S-shunn-classic] [S-maria] [S-gala]. SFWA's older guidance says
  "at least 1 inch" and a conference handout allows 1 to 1.5 in [S-sfwa-search]; Standard Manuscript Format lists 1, 1.25
  or 1.5 in [S-wiki].
- **Disagreement.** An Australian agency asks for 30 mm margins [S-curtisbrown-au].
- **Default.** 1 in (72 pt) top, bottom, left and right, on both paper sizes. On A4 that gives a 6.27 x 9.69 in text area.
- **Options.** Any value 0 to 4 in per side.

### Typeface and size

- **Rule.** 12 pt, black, a standard readable face: Times New Roman; Courier New is the accepted alternative ("on its way
  out, at least in fiction circles"). No sans-serif, nothing flashy. [S-shunn-story] [S-shunn-checklist]
  Agents: Times New Roman 12 [S-maria] [S-curtisbrown-au]. Shunn "Classic" means Courier. [S-shunn-classic]
- **Default.** Times New Roman 12 pt. Where it is not installed the generator falls back, in order, to metric-compatible
  free fonts (`FONT_FALLBACKS`): **Tinos**, **Liberation Serif** (Courier New: **Cousine**, **Liberation Mono**). Tinos and
  Cousine are SIL OFL / Apache-2.0 and have Times New Roman's and Courier New's glyph widths, so line and page breaks
  match.
- **Options.** The Classic preset (Courier New 12 pt). `fontFamily` and `fontSizePt` (8 to 24) can be set freely.

### Line spacing

- **Rule.** Double-spaced throughout, so the editor can mark up between the lines. [S-shunn-story] [S-shunn-checklist]
  [S-maria]. The UK agencies Blake Friedmann asks for 1.5 spacing "preferably" [S-blake]; Felicity Bryan "double or 1.5"
  [S-felicity]; Eve White "double line spaced" [S-evewhite].
- **Default.** Double, meaning Word's "Double": the baseline-to-baseline distance (the **pitch**) is 2 x the font's single
  line height. Both generators must produce the same pitch, so it is fixed here (12 pt text). Single line height is the
  font's ascent + descent + line gap (Times New Roman: 1825 + 443 + 87 of 2048 units = 1.1499 em; Courier New: 1705 +
  615 + 0 of 2048 = 1.1328 em). Tinos, Liberation Serif, Cousine and Liberation Mono carry the same vertical metrics.

  | Font (12 pt) | Single | Double (default) | 1.5 |
  |---|---|---|---|
  | Times New Roman / Tinos / Liberation Serif | 13.80 pt | **27.60 pt** | 20.70 pt |
  | Courier New / Cousine / Liberation Mono | 13.59 pt | **27.19 pt** | 20.39 pt |

  The typewriter pitch of Standard Manuscript Format is a fixed 24 pt line (24 lines per page [S-wiki]); it is not used.
  - **DOCX (`docx` library):** paragraph `spacing: { line: 480, lineRule: "auto", before: 0, after: 0 }` (240 = single,
    360 = 1.5, 480 = double). Word then derives 27.60 pt itself from the font.
  - **Typst:** text and paragraph settings, with the line box set to the font's ascender-to-descender height
    (Times 0.8911 + 0.2163 = 1.1074 em = 13.29 pt; Courier 0.8325 + 0.2998 = 1.1323 em = 13.59 pt), and `leading` the
    rest of the pitch:
    ```typst
    #set page(paper: "us-letter", margin: 1in)            // "a4" on A4
    #set text(size: 12pt, top-edge: "ascender", bottom-edge: "descender", hyphenate: false)
    #set par(leading: 14.31pt, spacing: 14.31pt, justify: false,   // Times: 27.60 - 13.29
             first-line-indent: (amount: 0.5in, all: true))        // Courier: leading and spacing 13.60pt
    ```
    `spacing` is set equal to `leading` so the pitch is the same between paragraphs as inside them (no extra gap). For
    1.5 and single, `leading = lineSpacing x single height - 13.29 pt` (Times) or `- 13.59 pt` (Courier).
    The metrics above are the published font values; the Typst ticket must assert, with a rendered page, that the
    baseline-to-baseline pitch equals the table value within 0.1 pt, and correct `leading` if Typst measures the line
    box differently.
- **Options.** 1.5 (for UK agencies that ask), single.

### Paragraphs and alignment

- **Rule.** First line of every paragraph indented 0.5 in, set as paragraph formatting, not with tabs or spaces; no extra
  space between paragraphs; text left-aligned with a ragged right margin (full justification is "typesetting style for
  finished copy"). [S-shunn-story] [S-shunn-checklist]
- **First paragraph.** Indent it too: "This applies even to the first paragraph of your manuscript. ... Indent that first
  line." [S-shunn-first]
- **Hyphenation.** No source states a rule. Default: **off** (ragged right with no automatic hyphenation, which keeps the
  words whole for the editor's markup and for the production team). Not an option.
- **Default.** 0.5 in indent on every paragraph including the first of a chapter and of a scene; 0 pt space before and
  after; left-aligned; hyphenation off.
- **Options.** `firstLineIndentIn` (0 to 2 in), `indentFirstParagraph` (a book-style first paragraph with no indent).

### Sentence spacing, emphasis, dashes, quotes

- **Rule.** One space between sentences (two in the Classic edition). [S-shunn-story] [S-shunn-flavors]
  Emphasis in italics; underline is the typewriter-era practice and the Classic preset; "choose italics in the absence of
  other instructions". [S-shunn-story] [S-shunn-checklist]
  Em dash as a real dash with no spaces round it; smart (curly) quotes on. [S-shunn-story]
- **Default.** One space, italics, em dashes unspaced, curly quotes (as typed in the editor).
- **Options.** `sentenceSpacing` (1 or 2), `italics` (`italic` or `underline`). Underline: render the italic runs of the
  manuscript as underlined, upright text.

## Title page

A novel has a separate title page. [S-shunn-novel]

### Contact block (upper left)

- **Rule.** Upper-left corner of the first page: legal name, address, phone number and email; pronouns optional;
  professional affiliations only when relevant. "You may omit any information you feel unsafe giving, though most top
  markets do request it all." [S-shunn-story] [S-shunn-checklist]. Larger markets need the legal name and address
  for contracts and tax paperwork; smaller markets accept a pen name and an email. [S-shunn-pii]
  SFWA (2025): the real name goes upper left and the pseudonym in the by-line; listing memberships is no longer
  standard. [S-sfwa-search]. UK agents want both the real name and the pen name on the sample and in the email. [S-blake]
- **Where the lines go.** First line at the top margin (1 in from the top edge), flush left, single-spaced, one item per
  line, in this order: legal name; address (one line per line of the address); phone; email; the agent or agency (only if
  `showAgent` and one is known). The sample in Shunn's novel guide shows exactly name, address, phone, email, then an
  affiliation. [S-shunn-novel-pdf]
- **Source of the details.** The app **author profile** in Settings (legal name, pen name, address, phone, email, agent),
  kept in the app config directory with the other preferences. A project may override individual fields; only then are
  contact details written into the project folder (`export.json`, `contact`). See project-format.md.
- **Default.** Show the contact block with whatever fields are filled in; the agent line is off.
- **Options.** `titlePage.showContact`, `titlePage.showAgent`; per-project override of any field.

### Word count (upper right)

- **Rule.** Upper-right corner of the first page: the word count from the word processor, "approximate", rounded "to the
  nearest hundred" (e.g. 1,507 words becomes 1,500); "if you're edging into novella territory, round to the nearest 500".
  [S-shunn-story] [S-shunn-checklist]. Use the computer-generated count, not the old rule of thumb. [S-shunn-wordcount]
  Shunn's novel title page reads "about 80,000 words". [S-shunn-novel-pdf]
- **Rounding rule (exact).** Take the app's word count (the word-count ticket's counter) and round half up to the step:
  under 20,000 words the step is 100; from 20,000 words (novella and up, so every novel) it is 500. 79,874 words prints
  "about 80,000 words"; 82,260 prints "about 82,500 words". Format with thousands separators and the words "about" and
  "words"; "1 word" is singular. (`roundWordCount()`, `formatWordCount()`.)
- **Default.** `auto` as above. **Options.** `nearest-100`, `nearest-500`, `nearest-1000` (common practice for novels, no
  primary source), `exact` (prints "82,260 words", no "about"). The 20,000 cut-off is Novel's reading of "novella
  territory"; Shunn gives no number.
- **Position.** Same line as the first line of the contact block, flush right at the right margin.

### Title and by-line

- **Rule.** Title centred on its own line "a third to halfway down the first page"; double-space once and centre the
  by-line below; the by-line is the name that gets credit, possibly a pen name; the legal name stays in the contact
  block ("each must appear in its appointed slot"). [S-shunn-story]. "Centered one-third to one-half of the way down first
  page". [S-shunn-checklist]. A novel's by-line reads "A Novel by Perry Slaughter". [S-shunn-novel-pdf]
- **Where.** The title starts one third of the text-area height below the top margin (3.0 in on Letter, 3.23 in on A4),
  centred, in the body font at 12 pt, the same weight as the text (no bold, no size change, no decoration). One blank
  double-spaced line, then the by-line centred. Nothing else on the page. Text starts on the next page.
- **Default.** By-line `A Novel by <name>`, where the name is the pen name if the profile has one, else the legal name.
  **Options.** `bylineStyle`: `a-novel-by`, `by`, `name-only`. The title page has no header and no page number.

## Running header and page numbers

- **Rule.** "Surname / Short Title / page number" (Shunn's sample: `Slaughter / Silvertide / 13`): the surname from the
  by-line, one or two keywords from the title, the page number; flush right in the upper-right corner; on every page but
  the title page. "Page numbering begins with 1 on the second page of the manuscript (the first page of actual text)."
  [S-shunn-novel] [S-shunn-story] [S-shunn-checklist]. Pages are numbered consecutively through the manuscript, never
  restarted per chapter. [S-gala]. Blake Friedmann: number all pages. [S-blake]
- **Default.** `Slaughter / Silvertide / 13`, 12 pt body font, flush right, header distance 0.5 in from the top edge
  (Word's default; inside the 1 in margin), no header on the title page, the first text page (physical page 2) prints `1`.
  The title in the header is typed as in the title (`titleCase: as-typed`); the short title defaults to the manuscript
  title and can be set to one or two keywords. The surname comes from the by-line name (`surnameOf()`: its last word,
  ignoring Jr., III...).
- **Disagreement.** The task brief writes the title in capitals (`Surname / TITLE / page`); Shunn's sample does not.
- **Options.** `header.format` (`surname-title-page`, `title-surname-page`, `surname-page`, `page`, `none`),
  `header.titleCase` (`as-typed`, `upper`), `header.shortTitle`, `header.startPage` (1 puts a header on the title page).

## Chapters and scenes

### Chapter openings

- **Rule.** "Each chapter begins on its own page." A part (`Part I`) or prologue heading, the chapter number
  (`Chapter 1`) and the chapter title sit on separate centred lines at the top of the opening page. [S-shunn-novel]
  Where the heading sits is not stated in the novel guide; the short-story guide's title position (a third to halfway
  down) and secondary guides ("about a third of the way down, text one double-spaced line below") give the convention.
  Consistency matters more than the exact position. [S-shunn-story] [S-gala]
- **Where.** Page break before every chapter. The heading block starts one third of the text-area height below the
  top margin (`chapterDropFraction = 1/3`: 3.0 in on Letter, 3.23 in on A4). Heading lines centred, body font and size,
  not bold: for example `Chapter 1`, then the title on the next line. Text starts one blank double-spaced line
  below the last heading line. The header keeps running and the page number continues.
- **Default.** Drop 1/3. **Options.** `chapterDropFraction` from 0 (top of the text area) to 0.5.

### Scene breaks

- **Rule.** "Center the symbol # on a line by itself. Don't just leave the line blank": a blank line can vanish at a page
  break. [S-shunn-story]. `* * *` is also accepted. [S-gala]
- **Default.** `#`, centred, no indent, a double-spaced line of its own between the two scenes. **Options.** `* * *` or
  any marker up to 20 characters.

### End marker

- **Rule.** "You don't need to make any explicit indication that your story is over", though some writers centre the word
  END after the last line. [S-shunn-story]
- **Default.** None. **Options.** `END`, `THE END` (centred, a double-spaced line below the last line).

## Footnotes

No source found in this research covers footnotes in a fiction manuscript (none of the guides mention them). Default:
footnotes stay real footnotes (DOCX footnotes, Typst `footnote`) at the foot of their page, in the body font at 12 pt
(no size reduction), single-spaced, separated from the text by a short rule. This is an implementer
default, not a publisher rule; the wizard should say that a market that does not want notes must have them removed.
Endnotes as an alternative are noted as a W2 option, not a stored setting yet.

## Word counts by genre

Used by the wizard's length check (`GENRE_WORD_COUNTS`, `checkWordCount()`). Agents' rules of thumb, not rules; the
wizard warns and never blocks. "Very long" is more than 25 % over the top of the range. A first novel of 130,000+ words
is "starting to get long for querying a debut". [S-broad]

| Genre | Typical range | Debut range | Sources |
|---|---|---|---|
| Literary fiction | 50,000 - 120,000 | (same) | [S-bransford] |
| Commercial / general fiction | 75,000 - 100,000 | 70,000 - 100,000 | [S-bransford], [S-broad] |
| Historical fiction | 80,000 - 120,000 | (same) | [S-bransford] |
| Fantasy | 80,000 - 120,000 | 100,000 - 120,000 | [S-bransford]; [S-broad] (adult SFF recommendations "more in the 100,000 to 120,000 range") |
| Science fiction | 90,000 - 120,000 | 100,000 - 120,000 | [S-bransford]; [S-broad] (as fantasy) |
| Romance | 50,000 - 90,000 | (same) | [S-bransford] |
| Mystery | 75,000 - 90,000 | (same) | [S-bransford] |
| Thriller | 80,000 - 100,000 | (same) | [S-bransford] |
| Young adult | 60,000 - 80,000 | (same) | [S-bransford] |
| Middle grade | 30,000 - 60,000 | 30,000 - 50,000 | [S-bransford], [S-broad] |

Debut guidance in the sources: "Most incredibly long and incredibly short books are not debuts"; an unusual length "may
indeed decrease your odds, especially for a debut" [S-bransford]; younger middle grade about 32,000, middle MG
30,000 - 50,000, older MG closer to 50,000 and longer [S-broad]. Blog roundups (Reedsy, Writer's Digest summaries)
return similar bands (adult 80,000 - 110,000; YA 50,000 - 80,000); they were not read directly and are not used.

## Submission packages (context, not layout)

UK agencies commonly ask for a synopsis and the first three chapters or 10,000 words, in Word, with the by-line and
contact details on the first page and a pen name given with the real name. [S-blake] [S-felicity] [S-evewhite]. An
Australian agency asks for double-spaced 12 pt Times New Roman with 30 mm margins, as Word or PDF. [S-curtisbrown-au]
Some agents want sample pages pasted into the email without indents or double spacing. [S-maria] The wizard's DOCX
output is the Word file; its PDF output is for markets that accept PDF.

## Sources

All accessed **2026-11-18**.

| Id | Source | URL |
|---|---|---|
| S-shunn-novel | William Shunn, Proper Manuscript Format, novel guide (page) | https://www.shunn.net/format/novel |
| S-shunn-novel-pdf | William Shunn, novel guide (PDF, 19 pp, sample manuscript "Silvertide") | https://www.shunn.net/format/pdf/ManuscriptFormat_Novel_WilliamShunn.pdf |
| S-shunn-story | William Shunn, Modern Manuscript Format (story guide, PDF; the full rules) | https://www.shunn.net/format/pdf/ManuscriptFormat_ShortStory_WilliamShunn.pdf |
| S-shunn-classic | William Shunn, Classic Manuscript Format | https://shunn.net/format/classic/ |
| S-shunn-flavors | Shunn, "Proper Manuscript Format Now Comes in Two Distinct Flavors" (Modern vs Classic) | https://www.shunn.net/format/2020/04/proper_manuscript_format_now_comes_in_two_distinct_flavors.html |
| S-shunn-checklist | Shunn, A Brief Manuscript Formatting Checklist (2024) | https://www.shunn.net/format/2024/01/a_brief_manuscript_formatting_checklist.html |
| S-shunn-paper | Shunn, Proper Paper Size for Manuscript Submissions (Letter / A4) | https://www.shunn.net/format/2014/10/proper_paper_size_for_manuscri.html |
| S-shunn-first | Shunn, The First Paragraph of Your Manuscript Should Look Like Any Other (2021) | https://www.shunn.net/format/2021/04/the_first_paragraph_of_your_manuscript_should_look_like_any_other.html |
| S-shunn-wordcount | Shunn, The Old Rule of Thumb for Estimating Word Count Is Obsolete (2021) | https://www.shunn.net/format/2021/04/the_old_rule_of_thumb_for_estimating_word_count_is_obsolete.html |
| S-shunn-pii | Shunn, Withholding Personally Identifiable Information (2026) | https://www.shunn.net/format/2026/07/withholding_personally_identifiable_information.html |
| S-sfwa-search | SFWA, Story Submission 101 (2025); SFWA FAQ for Beginning Writers; The Obligatory Manuscript Format Article; Vonda McIntyre, Manuscript Preparation (PDF). **Only read as search-result summaries**: the pages did not load through the fetch tool on the access date. Used only for statements that agree with Shunn (95 % of markets take Shunn Modern; real name upper left, pseudonym in the by-line; margins "about an inch"; double-spaced, right unjustified). | https://sfwa.org/2025/10/21/story-submission-101/ , https://sfwa.org/2005/01/04/faq-for-beginning-writers/ , https://www.sfwa.org/2005/01/04/the-obligatory-manuscript-format-article/ , https://www.sfwa.org/wp-content/uploads/2026/03/mssprep.pdf |
| S-wiki | Wikipedia, Standard manuscript format (typewriter-era Standard Manuscript Format: Courier, 24 lines, 0.5 in indent, margins 1 - 1.5 in) | https://en.wikipedia.org/wiki/Standard_manuscript_format |
| S-blake | Blake Friedmann Literary Agency (UK), submission guidelines: 1.5 spacing, number all pages, first page with title, name, contact details; pen name and real name; first three chapters or 10,000 words | https://blakefriedmann.co.uk/submissions |
| S-felicity | Felicity Bryan Associates (UK), submissions: legible font, double or 1.5 spacing, first three chapters up to 10,000 words | https://felicitybryan.com/?p=110 |
| S-evewhite | Eve White Literary Agency (UK), submissions: sample double line spaced, three chapters, one-page synopsis | https://evewhite.co.uk/submissions |
| S-curtisbrown-au | Curtis Brown Australia, submissions: double-spaced 12 pt Times New Roman, 30 mm margins, Word or PDF | https://curtisbrown.com.au/submissions |
| S-maria | Maria Vicente, literary agent (US), Formatting Your Manuscript and Sample Pages: Times New Roman 12, double, 1 in, page numbers | https://www.mariavicente.com/resources/manuscript-formatting |
| S-gala | Get a Literary Agent, Manuscript Format for Literary Agents: US Letter, 1 in, header with last name / short title / page, `#` or `* * *` for scene breaks, consecutive page numbers | https://getaliteraryagent.com/manuscript-format-literary-agents/ |
| S-bransford | Nathan Bransford, word counts by genre | https://nathanbransford.com/?p=9760 |
| S-broad | Kate Broad (literary agent), More on word count | https://katebroad.substack.com/p/more-on-word-count |

Notes on the sources:

- Shunn's text is licensed CC BY-NC-ND 4.0; this document paraphrases the rules and quotes short phrases with credit,
  and reproduces none of the guide's formatting or templates. Shunn asks that a manuscript carry no copyright notice.
- Shunn's novel guide PDF gives the sample layout but, in the text extracted, no inch measurements for chapter heading
  position; those come from the story guide and from secondary guides as marked under "Chapter openings".
- The agency pages were read for formatting only. A page that states nothing about a rule is not listed under it.
- Not found in any primary source and therefore Novel's own default: hyphenation off, the 20,000-word step of the "auto"
  rounding, the header distance of 0.5 in (Word's default), footnote handling.

Format variants at a glance: Standard (modern) is Shunn Modern; Classic is Shunn Classic; the UK variant is the Standard
preset on A4 with line spacing 1.5 (the wizard can offer it when the locale gives A4); the Australian variant adds
30 mm margins. These are settings combinations, not extra presets.
