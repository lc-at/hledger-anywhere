-- | WASI/browser stub for "System.Console.Terminal.Size".
--
-- The real package asks the operating system for the terminal size with an
-- @ioctl@, which WASI cannot do. In a browser the page *is* the terminal and it
-- does know how big it is, so it exports that in @$LINES@ and @$COLUMNS@ and this
-- stub reports it. Without them, every query answers "unknown" and hledger falls
-- back to its default report width, which is the right behaviour for a build
-- running anywhere else.
--
-- hledger deliberately does not read these variables itself, because a shell sets
-- them unreliably (see @Hledger.Utils.IO@). That reasoning does not apply here:
-- the values come from the terminal emulator, which redraws on every resize, and
-- the module below is consulted only because no other source of truth exists
-- under WASI.
--
-- The types and signatures mirror the BSD-3-Clause @terminal-size@ package so
-- that hledger's imports typecheck unchanged.
module System.Console.Terminal.Size
    ( Window (..)
    , size
    , hSize
    , fdSize
    ) where

import Data.Maybe (fromMaybe)
import System.Environment (lookupEnv)
import System.IO (Handle)
import Text.Read (readMaybe)

-- | A terminal window's dimensions in character cells.
data Window a = Window
    { height :: !a
    , width :: !a
    }
    deriving (Eq, Show, Read)

-- | The terminal size, from @$LINES@ and @$COLUMNS@.
--
-- A dimension that is missing or nonsense falls back to hledger's own default
-- (see @Hledger.Utils.IO@), and only when *neither* is set is the answer
-- 'Nothing'. Requiring both would make a caller that knows only its width — which
-- is the interesting half, since that is what reports are laid out to — report
-- "unknown" and get 80 columns regardless.
size :: Integral n => IO (Maybe (Window n))
size = do
    height <- envNumber "LINES"
    width <- envNumber "COLUMNS"
    pure $ case (height, width) of
        (Nothing, Nothing) -> Nothing
        (h, w) -> Just (Window (fromMaybe defaultHeight h) (fromMaybe defaultWidth w))

-- | hledger's own fallbacks, used for whichever dimension was not supplied.
defaultHeight :: Integral n => n
defaultHeight = 24

defaultWidth :: Integral n => n
defaultWidth = 80

-- | The same as 'size': under WASI there is no per-handle terminal to ask.
hSize :: Integral n => Handle -> IO (Maybe (Window n))
hSize _ = size

-- | The same as 'size': there is no file descriptor to interrogate.
fdSize :: Integral n => Int -> IO (Maybe (Window n))
fdSize _ = size

-- | A positive integer from the environment, or 'Nothing'.
envNumber :: Integral n => String -> IO (Maybe n)
envNumber name = do
    value <- lookupEnv name
    pure $ case value >>= (readMaybe :: String -> Maybe Integer) of
        Just number | number > 0 -> Just (fromInteger number)
        _ -> Nothing
