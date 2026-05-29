import Image from "next/image";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import Link from "next/link";

// Full AniList genre list with a representative cover for each. The
// search route accepts the genre name verbatim (?genres=<name>); names
// here must match AniList's canonical spelling.
const g = [
  {
    name: "Action",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20958-HuFJyr54Mmir.jpg",
  },
  {
    name: "Adventure",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21459-RoMP3pETHkfg.jpg",
  },
  {
    name: "Comedy",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21202-TfzXuWQf2oLQ.png",
  },
  {
    name: "Drama",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-PEn1CTc93blC.jpg",
  },
  {
    name: "Ecchi",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20954-MlhgU1f5dnro.jpg",
  },
  {
    name: "Fantasy",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101759-MdHvxQ3WlAUR.jpg",
  },
  {
    name: "Horror",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx127230-FlochcFsyoF4.png",
  },
  {
    name: "Mahou Shoujo",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9756-Asux3vsdLG9w.jpg",
  },
  {
    name: "Mecha",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx30-gxKZRWfWFFlR.jpg",
  },
  {
    name: "Music",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx130003-5Y8rYzg982sq.png",
  },
  {
    name: "Mystery",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101921-VHN3Cn2v0iQk.png",
  },
  {
    name: "Psychological",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-YJvLbgJQPCoI.jpg",
  },
  {
    name: "Romance",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx124080-h8EPH92nyRfS.jpg",
  },
  {
    name: "Sci-Fi",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9253-G7tDojBmDjVz.jpg",
  },
  {
    name: "Slice of Life",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx100217-akmHm1VTrLZX.png",
  },
  {
    name: "Sports",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20464-eW7ZDBOcn74a.png",
  },
  {
    name: "Supernatural",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101348-MdR3jKD8XGEc.jpg",
  },
  {
    name: "Thriller",
    img: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx142853-tFmsuUVZJExL.png",
  },
];

export default function Genres() {
  return (
    <div className="antialiased">
      <div className="flex items-center justify-between lg:justify-normal lg:gap-3 px-5">
        <h1 className="font-karla text-[20px] font-bold">Top Genres</h1>
        <ChevronRightIcon className="w-5 h-5" />
      </div>
      <div className="flex xl:justify-center items-center relative">
        <div className="bg-gradient-to-r from-primary to-transparent z-40 absolute w-7 h-full left-0" />
        <div className="flex lg:gap-8 gap-3 lg:p-10 py-8 px-5 z-30 overflow-y-hidden overflow-x-scroll snap-x snap-proximity scrollbar-none relative">
          <div className="flex lg:gap-10 gap-4">
            {g.map((a, index) => (
              <Link
                href={`/en/search/anime/?genres=${a.name}`}
                key={index}
                className="relative hover:shadow-lg hover:scale-105 duration-200 cursor-pointer ease-out h-[190px] w-[135px] lg:h-[265px] lg:w-[230px] rounded-md shrink-0"
              >
                <div className="bg-gradient-to-b from-transparent to-[#0c0d10] h-[190px] w-[135px] lg:h-[265px] lg:w-[230px] rounded-md absolute flex justify-center items-end">
                  <h1 className="pb-7 lg:text-xl font-karla font-semibold">
                    {a.name}
                  </h1>
                </div>
                <Image
                  src={a.img}
                  alt="genres images"
                  width={1000}
                  height={1000}
                  className="object-cover shrink-0 h-[190px] w-[135px] lg:h-[265px] lg:w-[230px] rounded-md"
                />
              </Link>
            ))}
          </div>
        </div>
        <div className="bg-gradient-to-l from-primary to-transparent z-40 absolute w-7 h-full right-0" />
      </div>
    </div>
  );
}
