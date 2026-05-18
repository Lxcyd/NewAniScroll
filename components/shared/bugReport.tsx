import { Fragment, useState } from "react";
import { Dialog, Listbox, Transition } from "@headlessui/react";
import { CheckIcon, ChevronDownIcon } from "@heroicons/react/20/solid";
import { toast } from "sonner";

const severityOptions = [
  { id: 1, name: "Low" },
  { id: 2, name: "Medium" },
  { id: 3, name: "High" },
  { id: 4, name: "Critical" },
];

interface BugReportFormProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
}

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const BugReportForm: React.FC<BugReportFormProps> = ({ isOpen, setIsOpen }) => {
  const [bugTitle, setBugTitle] = useState("");
  const [bugDescription, setBugDescription] = useState("");
  const [severity, setSeverity] = useState(severityOptions[0]);
  const [images, setImages] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function closeModal() {
    setIsOpen(false);
    setBugTitle("");
    setBugDescription("");
    setSeverity(severityOptions[0]);
    setImages([]);
  }

  // Convert a single File → data URL. Resolves null when the file is
  // too large or not an image.
  const fileToDataUrl = (file: File): Promise<string | null> =>
    new Promise((resolve) => {
      if (!file.type.startsWith("image/")) return resolve(null);
      if (file.size > MAX_IMAGE_BYTES) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const slots = MAX_IMAGES - images.length;
    if (slots <= 0) {
      toast.error(`You already attached ${MAX_IMAGES} images.`);
      return;
    }
    const chosen = Array.from(files).slice(0, slots);
    const encoded = await Promise.all(chosen.map(fileToDataUrl));
    const valid = encoded.filter((x): x is string => Boolean(x));
    const rejected = encoded.length - valid.length;
    if (rejected > 0) {
      toast.error(`${rejected} file(s) skipped (too large or not an image).`);
    }
    if (valid.length) setImages((cur) => [...cur, ...valid]);
  };

  const removeImage = (i: number) => {
    setImages((cur) => cur.filter((_, idx) => idx !== i));
  };

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    const bugReport = {
      title: bugTitle,
      desc: bugDescription,
      severity: severity.name,
      url: window.location.href,
      createdAt: new Date().toISOString(),
      images,
    };

    try {
      const res = await fetch("/api/v2/admin/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: bugReport }),
      });

      const json = await res.json();
      if (res.status === 429) {
        toast.error(json.message || "Too many reports, please wait.");
        return;
      }
      if (!res.ok) {
        toast.error(json.error || "Submission failed.");
        return;
      }
      toast.success(json.message);
      closeModal();
    } catch (err: any) {
      console.log(err);
      toast.error("Something went wrong: " + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Transition appear show={isOpen} as={Fragment}>
        {/* Navbar is z-[9999] (cf. components/shared/NavBar.tsx) so the
            modal needs to sit above it; otherwise the dialog renders
            *behind* the fixed navbar at the top of the viewport. */}
        <Dialog as="div" className="relative z-[10000]" onClose={closeModal}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black bg-opacity-90" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4 ">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel className="w-full max-w-md transition-all">
                  <div className="bg-secondary p-6 rounded-lg shadow-xl">
                    <h2 className={`text-action text-2xl font-semibold mb-4`}>
                      Report a Bug
                    </h2>
                    <form onSubmit={handleSubmit}>
                      <div className="space-y-4">
                        <div>
                          <label
                            htmlFor="bugTitle"
                            className="block text-txt text-sm font-medium mb-2"
                          >
                            Title
                          </label>
                          <input
                            id="bugTitle"
                            type="text"
                            maxLength={120}
                            className="w-full bg-image text-txt rounded-md border border-txt focus:ring-action focus:border-action transition duration-300 focus:outline-none py-2 px-3"
                            placeholder="Short summary, e.g. 'Subtitles disappear in fullscreen'"
                            value={bugTitle}
                            onChange={(e) => setBugTitle(e.target.value)}
                            required
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="bugDescription"
                            className={`block text-txt text-sm font-medium mb-2`}
                          >
                            Description
                          </label>
                          <textarea
                            id="bugDescription"
                            name="bugDescription"
                            rows={4}
                            className={`w-full bg-image text-txt rounded-md border border-txt focus:ring-action focus:border-action transition duration-300 focus:outline-none py-2 px-3`}
                            placeholder="Steps to reproduce, what happened, what you expected…"
                            value={bugDescription}
                            onChange={(e) => setBugDescription(e.target.value)}
                            required
                          ></textarea>
                        </div>
                        <Listbox value={severity} onChange={setSeverity}>
                          <div className="relative mt-1">
                            <label
                              htmlFor="severity"
                              className={`block text-txt text-sm font-medium mb-2`}
                            >
                              Severity
                            </label>
                            <Listbox.Button
                              type="button"
                              className="relative w-full cursor-pointer hover:shadow-xl hover:scale-[1.01] transition-all rounded-lg bg-image py-2 pl-3 pr-10 text-left shadow-md sm:text-base duration-300"
                            >
                              <span className="block truncate text-white font-semibold">
                                {severity.name}
                              </span>
                              <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                                <ChevronDownIcon
                                  className="h-5 w-5 text-gray-400"
                                  aria-hidden="true"
                                />
                              </span>
                            </Listbox.Button>
                            <Transition
                              as={Fragment}
                              leave="transition ease-in duration-100"
                              leaveFrom="opacity-100"
                              leaveTo="opacity-0"
                            >
                              <Listbox.Options className="absolute mt-1 max-h-60 w-full overflow-auto rounded-md bg-image py-1 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm">
                                {severityOptions.map((person, personIdx) => (
                                  <Listbox.Option
                                    key={personIdx}
                                    className={({ active }) =>
                                      `relative cursor-default select-none py-2 pl-10 pr-4 ${
                                        active
                                          ? "bg-secondary/50 text-white"
                                          : "text-gray-400"
                                      }`
                                    }
                                    value={person}
                                  >
                                    {({ selected }) => (
                                      <>
                                        <span
                                          className={`block truncate ${
                                            selected
                                              ? "font-medium text-white"
                                              : "font-normal"
                                          }`}
                                        >
                                          {person.name}
                                        </span>
                                        {selected ? (
                                          <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-action">
                                            <CheckIcon
                                              className="h-5 w-5"
                                              aria-hidden="true"
                                            />
                                          </span>
                                        ) : null}
                                      </>
                                    )}
                                  </Listbox.Option>
                                ))}
                              </Listbox.Options>
                            </Transition>
                          </div>
                        </Listbox>
                      </div>

                      {/* Image attachments — up to 5, max 2 MB each */}
                      <div className="mt-4">
                        <label className="block text-txt text-sm font-medium mb-2">
                          Screenshots ({images.length}/{MAX_IMAGES})
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {images.map((src, i) => (
                            <div key={i} className="relative">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={src}
                                alt=""
                                className="w-16 h-16 object-cover rounded ring-1 ring-white/10"
                              />
                              <button
                                type="button"
                                onClick={() => removeImage(i)}
                                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-rose-600 text-white text-xs flex-center hover:bg-rose-500"
                                aria-label="Remove"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          {images.length < MAX_IMAGES && (
                            <label className="w-16 h-16 rounded ring-1 ring-white/15 hover:ring-action cursor-pointer flex-center text-white/40 hover:text-white text-2xl transition-colors">
                              +
                              <input
                                type="file"
                                accept="image/*"
                                multiple
                                hidden
                                onChange={(e) => handleFiles(e.target.files)}
                              />
                            </label>
                          )}
                        </div>
                        <p className="mt-1 text-[10px] text-white/40">
                          Max 2&nbsp;MB per image.
                        </p>
                      </div>

                      <div className="mt-4">
                        <button
                          type="submit"
                          disabled={submitting}
                          className={`w-full bg-action text-white py-2 px-4 rounded-md font-semibold hover:bg-action/80 focus:ring focus:ring-action focus:outline-none transition duration-300 disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                          {submitting ? "Sending…" : "Submit Bug Report"}
                        </button>
                      </div>
                    </form>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>
    </>
  );
};

export default BugReportForm;
