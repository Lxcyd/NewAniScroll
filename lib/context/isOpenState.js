import React, { createContext, useContext, useEffect, useState } from "react";

const SearchContext = createContext();

export const SearchProvider = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);

  /*
   * Ctrl+S toggles the palette. The listener lives HERE rather than inside
   * SearchPalette on purpose: the palette (headless-ui dialog + combobox, the
   * AniList quick-search client and the search-by-image panel) is now mounted
   * only once the visitor has actually opened it, so its code can stay out of
   * the shared _app chunk that every page downloads. A shortcut whose handler
   * sits inside the component it is meant to reveal cannot do that.
   *
   * Clearing the previous query used to happen here too; SearchPalette now
   * does it itself when `isOpen` flips true, which is the moment that matters.
   */
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === "KeyS" && e.ctrlKey) {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <SearchContext.Provider value={{ isOpen, setIsOpen }}>
      {children}
    </SearchContext.Provider>
  );
};

export function useSearch() {
  return useContext(SearchContext);
}
