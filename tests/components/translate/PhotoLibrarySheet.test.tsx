// @vitest-environment jsdom
// The in-app photo library — the grid of what DINO can actually see under iOS limited
// access, and the home of Manage.
//
// What's pinned is what makes it worth having at all: it shows the SHARED photos (the
// system picker can't, it runs out of process), Manage sits on that grid, and widening
// the selection re-reads it rather than leaving a stale answer on screen.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";

const { listLibraryPhotos, loadLibraryPhoto, selectMorePhotos, openPhotoSettings, onLibraryChange } = vi.hoisted(
  () => ({
    listLibraryPhotos: vi.fn(),
    loadLibraryPhoto: vi.fn(),
    selectMorePhotos: vi.fn(),
    openPhotoSettings: vi.fn(),
    onLibraryChange: vi.fn(),
  }),
);

vi.mock("@/services/photos/access", () => ({
  listLibraryPhotos,
  loadLibraryPhoto,
  selectMorePhotos,
  openPhotoSettings,
  onLibraryChange,
}));

import { PhotoLibrarySheet } from "@/components/translate/PhotoLibrarySheet";

const SHARED = [
  { id: "a", thumb: "AAA" },
  { id: "b", thumb: "BBB" },
];

function renderSheet(overrides: Partial<Parameters<typeof PhotoLibrarySheet>[0]> = {}) {
  const props = {
    onPick: vi.fn(),
    onClose: vi.fn(),
    onAccessChange: vi.fn(),
    ...overrides,
  };
  render(
    <LocaleProvider>
      <PhotoLibrarySheet {...props} />
    </LocaleProvider>,
  );
  return props;
}

let libraryChanged: () => void = () => {};
let unsubscribe = vi.fn();

const tiles = () => screen.queryAllByRole("button", { name: /scan text from this photo/i });
const manage = () => screen.getByRole("button", { name: /manage/i });

beforeEach(() => {
  vi.clearAllMocks();
  listLibraryPhotos.mockResolvedValue(SHARED);
  loadLibraryPhoto.mockResolvedValue({ base64: "FULL", format: "jpeg" });
  selectMorePhotos.mockResolvedValue("limited");
  // Capture the subscriber so a test can play the part of iOS reporting a change.
  libraryChanged = () => {};
  unsubscribe = vi.fn();
  onLibraryChange.mockImplementation((fn: () => void) => {
    libraryChanged = fn;
    return unsubscribe;
  });
});
afterEach(cleanup);

describe("PhotoLibrarySheet", () => {
  it("shows a tile per shared photo", async () => {
    renderSheet();
    await waitFor(() => expect(tiles()).toHaveLength(2));
  });

  it("hands back the FULL image for a tapped tile, not its thumbnail", async () => {
    const { onPick } = renderSheet();
    await waitFor(() => expect(tiles()).toHaveLength(2));
    fireEvent.click(tiles()[1]);
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(loadLibraryPhoto).toHaveBeenCalledWith("b");
    expect(onPick).toHaveBeenCalledWith({ base64: "FULL", format: "jpeg" });
  });

  it("says so when nothing has been shared, rather than looking broken", async () => {
    listLibraryPhotos.mockResolvedValue([]);
    renderSheet();
    // "Limit Access" then selecting nothing is a real state, and Manage is the way out.
    await waitFor(() => expect(screen.getByText(/no photos shared yet/i)).toBeTruthy());
    expect(manage()).toBeTruthy();
  });

  it("re-reads the grid after the user selects more photos", async () => {
    renderSheet();
    await waitFor(() => expect(listLibraryPhotos).toHaveBeenCalledTimes(1));
    fireEvent.click(manage());
    fireEvent.click(screen.getByRole("button", { name: /select more photos/i }));
    // The selection IS this grid, so a stale one would be showing the wrong answer.
    await waitFor(() => expect(listLibraryPhotos).toHaveBeenCalledTimes(2));
  });

  it("shows photos added through Manage once iOS commits them, without reopening", async () => {
    renderSheet();
    await waitFor(() => expect(tiles()).toHaveLength(2));
    // iOS closes the "select more" sheet BEFORE committing the selection, so the re-read
    // on close sees the old two; the commit arrives afterwards as a library change.
    fireEvent.click(manage());
    fireEvent.click(screen.getByRole("button", { name: /select more photos/i }));
    await waitFor(() => expect(listLibraryPhotos).toHaveBeenCalledTimes(2));
    listLibraryPhotos.mockResolvedValue([...SHARED, { id: "c", thumb: "CCC" }]);
    libraryChanged();
    await waitFor(() => expect(tiles()).toHaveLength(3));
  });

  it("collapses a burst of change notifications into one re-read", async () => {
    renderSheet();
    await waitFor(() => expect(listLibraryPhotos).toHaveBeenCalledTimes(1));
    libraryChanged();
    libraryChanged();
    libraryChanged();
    await waitFor(() => expect(listLibraryPhotos).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 400));
    expect(listLibraryPhotos).toHaveBeenCalledTimes(2);
  });

  it("stops listening when the sheet closes", async () => {
    renderSheet();
    await waitFor(() => expect(onLibraryChange).toHaveBeenCalled());
    cleanup();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("reports a switch to full access up, so the host can retire the sheet", async () => {
    selectMorePhotos.mockResolvedValue("full");
    const { onAccessChange } = renderSheet();
    await waitFor(() => expect(tiles()).toHaveLength(2));
    fireEvent.click(manage());
    fireEvent.click(screen.getByRole("button", { name: /select more photos/i }));
    await waitFor(() => expect(onAccessChange).toHaveBeenCalledWith("full"));
  });

  it("offers Change Settings, the only route to full access once the prompt is answered", async () => {
    renderSheet();
    await waitFor(() => expect(tiles()).toHaveLength(2));
    fireEvent.click(manage());
    fireEvent.click(screen.getByRole("button", { name: /change settings/i }));
    expect(openPhotoSettings).toHaveBeenCalledTimes(1);
  });

  it("backing out of Manage returns to the photos rather than closing the picker", async () => {
    const { onClose } = renderSheet();
    await waitFor(() => expect(tiles()).toHaveLength(2));
    fireEvent.click(manage());
    expect(screen.getByRole("menu")).toBeTruthy();
    // Tap off the menu: the scrim swallows it, so the sheet itself is untouched.
    fireEvent.click(document.querySelector(".photolib__menuscrim") as Element);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(tiles()).toHaveLength(2);
  });

  it("has exactly ONE control named Cancel, so the label is unambiguous", async () => {
    renderSheet();
    await waitFor(() => expect(tiles()).toHaveLength(2));
    fireEvent.click(manage());
    expect(screen.getAllByRole("button", { name: /^cancel$/i })).toHaveLength(1);
  });
});
