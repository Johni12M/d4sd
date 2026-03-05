# digi4school-downloader

> This is a fork of [d4sd by garzj](https://github.com/garzj/d4sd). Huge thanks to [@garzj](https://github.com/garzj) for the original project — all the hard work is theirs! 🙏

## Additional Features in This Fork

- **Klett shelf support** *(work in progress — not fully functional yet)*  
  Download books from https://bridge.klett.de/ using `--shelf klett`
- **Helbling shelf support**  
  Download books from Helbling e-zone using `--shelf helbling`
- **`--page-count` flag**  
  Manually specify the page count when auto-detection fails:  
  `d4sd --shelf klett -u <user> --page-count 200 "https://bridge.klett.de/..."`
- **`--all-missing` / `--list-missing` flags**  
  Skip books already present in the output directory
- **Improved error resilience**  
  Failed individual pages are retried and skipped instead of crashing the whole download; missing or corrupt pages are skipped during PDF merge

## Features

- Download books and archives with folders and additional documents from https://digi4school.at/

  Supports linked books from:
  - Scook (https://www.scook.at/)
  - Westermann BiBox (https://bibox2.westermann.de/)
  - various others like https://hpthek.at/

- Download books from https://www.scook.at/ (only by url)
- Typescript API

## Installation

- Install [Node.js + npm](https://nodejs.org/)
- `npm i -g d4sd@latest`
  - (or use `yarn global add d4sd@latest`)
  - (or replace `d4sd` with `npx d4sd@latest` for all commands)

## Usage

Basic usage  
`d4sd -u <user> <...books>`

Specify a password and an output folder  
`d4sd -u <user> -p <password> -o ./download/ <...books>`

Download specific books using a glob pattern  
`d4sd -u john.doe@example.com -o ./download/ "Grundlagen d?? Elektrotechnik (2|3)*"`

Download your whole shelf  
`d4sd -u john.doe@example.com -o ./download/ "*"`

Download a book using an url  
`d4sd -u john.doe@example.com "https://digi4school.at/ebook/xxxxxxxxxxxx"` (`"another url"`...)

Download a book from Scook  
`d4sd -s scook -u john.doe@example.com "https://www.scook.at/produkt/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`

Download a book from Trauner DigiBox  
`d4sd -s trauner -u john.doe@example.com "Englisch *"`

Download a book from Klett bridge *(WIP)*  
`d4sd -s klett -u john.doe@example.com --page-count <N> "https://bridge.klett.de/..."`

More options can be found with `d4sd -h`.

**Note:** On Linux, make sure to use single quotes `'` instead of `"`.

### Slow internet connections

On slow networks I'd recommend setting the timeout to a higher value  
`d4sd -u <user> -t 180000 "*"`

## Disclaimer

This project is only for educational purposes. Don't download books with this tool please.
