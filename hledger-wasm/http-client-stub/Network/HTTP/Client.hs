-- | WASI/browser stub for "Network.HTTP.Client".
--
-- Only the exception constructors hledger's @setup@ command pattern-matches on,
-- and the two accessors it would apply to a response. None of it can run: the
-- stub 'Network.HTTP.Req.req' throws before a request is ever attempted.
--
-- See http-client.cabal for why this package exists.
module Network.HTTP.Client
    ( HttpException (..)
    , HttpExceptionContent (..)
    , Request
    , Response
    , responseStatus
    , responseHeaders
    ) where

import Control.Exception (Exception)
import Data.ByteString (ByteString)
import Network.HTTP.Types (ResponseHeaders, Status)

-- | A request. Carries nothing, because no request is ever sent.
data Request = Request deriving (Show)

-- | A response. Carries nothing, for the same reason.
data Response body = Response deriving (Show)

-- | The exception type of the real @http-client@.
data HttpException
    = HttpExceptionRequest Request HttpExceptionContent
    | InvalidUrlException String String
    deriving (Show)

instance Exception HttpException

-- | Why a request failed. Only the redirect case is matched by hledger.
data HttpExceptionContent
    = StatusCodeException (Response ()) ByteString
    | OtherHttpException
    deriving (Show)

-- | Unreachable at runtime.
--
-- 'Network.HTTP.Req.req' throws 'Network.HTTP.Req.JsonHttpException', so the
-- 'StatusCodeException' branch hledger matches is never entered and no
-- @Response@ value is ever built. Defined as an error rather than given a fake
-- value so that, if that ever stops being true, it fails loudly instead of
-- reporting a nonsense status.
responseStatus :: Response body -> Status
responseStatus _ = error "http-client wasm stub: responseStatus is unavailable"

-- | Unreachable at runtime; see 'responseStatus'.
responseHeaders :: Response body -> ResponseHeaders
responseHeaders _ = error "http-client wasm stub: responseHeaders is unavailable"
