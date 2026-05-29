import Image from "next/image";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRef } from "react";

// Full AniList genre list with a representative cover for each. The search
// route accepts the genre name verbatim (?genres=<name>); names here must
// match AniList's canonical spelling. URLs use the /medium/ variant — it's
// the size AniList guarantees for every entry (some older covers 404 on
// /large/) and ~230px wide is exactly the card width, so no quality loss.
const CDN = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium";
const g = [
  { name: "Action", img: `${CDN}/bx16498-buvcRTBx4NSm.jpg` }, // Attack on Titan
  { name: "Adventure", img: `${CDN}/bx21-ELSYx3yMPcKM.jpg` }, // One Piece
  { name: "Comedy", img: `${CDN}/bx21202-mPOr80AEjUcZ.png` }, // KonoSuba
  { name: "Drama", img: `${CDN}/bx21827-ubzq619ZA2E9.png` }, // Violet Evergarden
  { name: "Ecchi", img: `${CDN}/b19815-sEOQ9yQaPKlk.jpg` }, // No Game No Life
  { name: "Fantasy", img: `${CDN}/bx11061-y5gsT1hoHuHw.png` }, // Hunter x Hunter
  { name: "Horror", img: `${CDN}/b20605-k665mVkSug8D.jpg` }, // Tokyo Ghoul
  { name: "Mahou Shoujo", img: `${CDN}/bx9756-QnUGwlwwnsuN.jpg` }, // Madoka Magica
  { name: "Mecha", img: `${CDN}/nx99423-8MBxtwCeHf8B.png` }, // Darling in the Franxx
  { name: "Music", img: `${CDN}/bx20665-TLgkL8T8IRFd.png` }, // Your Lie in April
  { name: "Mystery", img: `${CDN}/bx21234-XmqW39aQ9o7O.jpg` }, // Erased
  { name: "Psychological", img: `${CDN}/bx1535-kUgkcrfOrkUM.jpg` }, // Death Note
  { name: "Romance", img: `${CDN}/bx21519-SUo3ZQuCbYhJ.png` }, // Your Name
  { name: "Sci-Fi", img: `${CDN}/bx9253-tIUXF2gfU8Sg.jpg` }, // Steins;Gate
  { name: "Slice of Life", img: `${CDN}/bx140960-Kb6R5nYQfjmP.jpg` }, // Spy x Family
  { name: "Sports", img: `${CDN}/bx20464-ooZUyBe4ptp9.png` }, // Haikyuu
  { name: "Supernatural", img: `${CDN}/bx113415-LHBAeoZDIsnF.jpg` }, // Jujutsu Kaisen
  { name: "Thriller", img: `${CDN}/bx101759-8UR7r9MNVpz2.jpg` }, // The Promised Neverland
];

export default function Genres() {
  const scrollRef = useRef(null);
  // Drag-to-scroll state. `moved` flips true once the pointer travels past
  // the threshold so the click-capture handler can swallow the navigation
  // — otherwise a horizontal drag would also follow the genre <Link>.
  const drag = useRef({ down: false, startX: 0, scrollStart: 0, moved: false });

  const onPointerDown = (e) => {
    const el = scrollRef.current;
    if (!el) return;
    drag.current = {
      down: true,
      startX: e.clientX,
      scrollStart: el.scrollLeft,
      moved: false,
    };
  };
  const onPointerMove = (e) => {
    const el = scrollRef.current;
    if (!el || !drag.current.down) return;
    const dx = e.clientX - drag.current.startX;
    if (Math.abs(dx) > 5) drag.current.moved = true;
    el.scrollLeft = drag.current.scrollStart - dx;
  };
  const endDrag = () => {
    drag.current.down = false;
  };
  // Capture phase: if the pointer dragged, cancel the link navigation. The
  // flag is reset here so the next genuine click (no drag) still works.
  const onClickCapture = (e) => {
    if (drag.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      drag.current.moved = false;
    }
  };

  return (
    <div className="antialiased">
      <div className="flex items-center justify-between lg:justify-normal lg:gap-3 px-5">
        <h1 className="font-karla text-[20px] font-bold">Top Genres</h1>
        <ChevronRightIcon className="w-5 h-5" />
      </div>
      <div className="flex items-center relative">
        <div className="bg-gradient-to-r from-primary to-transparent z-40 absolute w-7 h-full left-0 pointer-events-none" />
        <div
          ref={scrollRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onClickCapture={onClickCapture}
          className="flex lg:gap-10 gap-4 lg:p-10 py-8 px-5 z-30 overflow-y-hidden overflow-x-scroll scrollbar-none relative cursor-grab active:cursor-grabbing select-none"
        >
          {g.map((a, index) => (
            <Link
              href={`/en/search/anime/?genres=${a.name}`}
              key={index}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              className="relative hover:shadow-lg hover:scale-105 duration-200 cursor-pointer ease-out h-[190px] w-[135px] lg:h-[265px] lg:w-[230px] rounded-md shrink-0"
            >
              <div className="bg-gradient-to-b from-transparent to-[#0c0d10] h-[190px] w-[135px] lg:h-[265px] lg:w-[230px] rounded-md absolute flex justify-center items-end z-10">
                <h1 className="pb-7 lg:text-xl font-karla font-semibold">
                  {a.name}
                </h1>
              </div>
              <Image
                src={a.img}
                alt={a.name}
                width={1000}
                height={1000}
                draggable={false}
                className="object-cover shrink-0 h-[190px] w-[135px] lg:h-[265px] lg:w-[230px] rounded-md pointer-events-none"
              />
            </Link>
          ))}
        </div>
        <div className="bg-gradient-to-l from-primary to-transparent z-40 absolute w-7 h-full right-0 pointer-events-none" />
      </div>
    </div>
  );
}
