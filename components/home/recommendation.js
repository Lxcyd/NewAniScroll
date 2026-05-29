import Image from "next/image";
import { useRef, useState } from "react";
import Link from "next/link";
import { useDraggable } from "react-use-draggable-scroll";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { ChevronLeftIcon } from "@heroicons/react/20/solid";
import { MdChevronRight } from "react-icons/md";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";

export default function UserRecommendation({ data }) {
  const titlePref = useTitlePref();
  const ref = useRef(null);
  const { events } = useDraggable(ref);

  const dragMovedRef = useRef(false);
  const downPosRef = useRef(null);
  const DRAG_THRESHOLD = 8;

  const onPointerDownCapture = (e) => {
    dragMovedRef.current = false;
    downPosRef.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUpCapture = (e) => {
    const start = downPosRef.current;
    if (!start) return;
    const dx = Math.abs(e.clientX - start.x);
    const dy = Math.abs(e.clientY - start.y);
    if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) dragMovedRef.current = true;
    downPosRef.current = null;
  };
  const onClickCapture = (e) => {
    if (dragMovedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      dragMovedRef.current = false;
    }
  };

  const [scrollLeft, setScrollLeft] = useState(false);
  const [scrollRight, setScrollRight] = useState(true);

  const handleScroll = (e) => {
    setScrollLeft(e.target.scrollLeft > 31);
    setScrollRight(
      e.target.scrollLeft < e.target.scrollWidth - e.target.clientWidth
    );
  };

  const seen = new Set();
  const filteredData = data.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  return (
    <div>
      <div className="flex items-center justify-between lg:justify-normal lg:gap-3 px-5 z-40">
        <h1 className="font-karla text-[20px] font-bold">Recommendations</h1>
        <ChevronRightIcon className="w-5 h-5" />
      </div>
      <div className="relative flex items-center lg:gap-2">
        <div
          className={`flex items-center mb-5 cursor-pointer hover:text-action absolute left-0 bg-gradient-to-r from-[#0c0d10] z-40 h-full hover:opacity-100 ${
            scrollLeft ? "lg:visible" : "invisible"
          }`}
        >
          <ChevronLeftIcon className="w-7 h-7 stroke-2" />
        </div>
        <div
          id="recommendationList"
          className="flex h-full w-full select-none overflow-x-scroll overflow-y-hidden scrollbar-hide lg:gap-8 gap-4 lg:p-10 py-8 px-5 z-30"
          onScroll={handleScroll}
          onPointerDownCapture={onPointerDownCapture}
          onPointerUpCapture={onPointerUpCapture}
          onClickCapture={onClickCapture}
          {...events}
          ref={ref}
        >
          {filteredData.slice(0, 15).map((i) => (
            <div
              key={i.id}
              className="flex flex-col gap-3 shrink-0 cursor-pointer"
            >
              <Link
                href={`/en/${i.type?.toLowerCase() ?? "anime"}/${i.id}`}
                className="hover:scale-105 hover:shadow-lg duration-300 ease-out group relative"
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
              >
                <div className="h-[190px] w-[135px] lg:h-[265px] lg:w-[185px] rounded-md z-30">
                  {i.coverImage?.extraLarge && (
                    <Image
                      draggable={false}
                      src={i.coverImage.extraLarge}
                      alt={pickTitle(i.title, titlePref)}
                      width={500}
                      height={300}
                      className="z-20 h-[190px] w-[135px] lg:h-[265px] lg:w-[185px] object-cover rounded-md brightness-90"
                    />
                  )}
                </div>
              </Link>
              <Link
                href={`/en/${i.type?.toLowerCase() ?? "anime"}/${i.id}`}
                className="w-[135px] lg:w-[185px] line-clamp-2"
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
              >
                <h1 className="font-karla font-semibold xl:text-base text-[15px]">
                  {i.status === "RELEASING" ? (
                    <span className="dots bg-green-500" />
                  ) : i.status === "NOT_YET_RELEASED" ? (
                    <span className="dots bg-red-500" />
                  ) : null}
                  {pickTitle(i.title, titlePref)}
                </h1>
              </Link>
            </div>
          ))}
        </div>
        <MdChevronRight
          size={30}
          className={`hidden md:block mb-5 cursor-pointer hover:text-action absolute right-0 bg-gradient-to-l from-[#0c0d10] z-40 h-full hover:opacity-100 ${
            scrollRight ? "visible" : "hidden"
          }`}
        />
      </div>
    </div>
  );
}
